import express from "express";
import cors from "cors";
import session from "express-session";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import pg from "pg";
const { Pool } = pg;
import bcrypt from "bcrypt";
import env from "dotenv";
import OpenAI from "openai";
import nodemailer from "nodemailer";

env.config();

const app = express();
const port = 5000;

// Middleware
app.use(cors({
    origin: 'http://localhost:5173',
    credentials: true,
}));

app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'yourSecret', // set in .env ideally
    resave: false,
    saveUninitialized: false,
}));

app.use(passport.initialize());
app.use(passport.session());

// Create a connection pool to PostgreSQL
const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
});

// Configure Passport Local Strategy
passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
    try {
        const queryText = 'SELECT * FROM users WHERE email = $1';
        const { rows } = await pool.query(queryText, [email]);
        if (rows.length === 0) {
            return done(null, false, { message: 'Incorrect email.' });
        }
        const user = rows[0];
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return done(null, false, { message: 'Incorrect password.' });
        return done(null, user);
    } catch (error) {
        return done(error);
    }
}));

passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const queryText = 'SELECT * FROM users WHERE id = $1';
        const { rows } = await pool.query(queryText, [id]);
        if (rows.length === 0) return done(new Error('User not found'));
        done(null, rows[0]);
    } catch (error) {
        done(error);
    }
});

// Registration Route
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    try {
        // Check if user exists
        const userExists = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userExists.rows.length > 0) {
            return res.status(400).json({ message: 'User already exists' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const insertQuery = 'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING *';
        const { rows } = await pool.query(insertQuery, [email, hashedPassword]);
        // Log in the user automatically after registration (optional)
        req.login(rows[0], (err) => {
            if (err) {
                return res.status(500).json({ message: 'Error logging in after registration' });
            }
            res.json(rows[0]);
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

  // Login Route
app.post('/api/login', passport.authenticate('local'), (req, res) => {
    res.json(req.user);
});

  // Logout Route
app.post('/api/logout', (req, res) => {
    req.logout(function(err) {
        if (err) { return res.status(500).json({ message: 'Logout failed' }); }
        res.json({ message: 'Logged out' });
    });
});

// Route to check current user session
app.get("/api/current-user", (req, res) => {
    if (req.user) {
        res.json(req.user);
    } else {
        res.status(401).json({ message: "Not authenticated" });
    }
});

function isAuthenticatedAndAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ message: "Unauthorized" });
    }
    if (!req.user.isadmin) {
        return res.status(403).json({ message: "Forbidden" });
    }
    next();
}


const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY environment variable.");
}

const ASSISTANT_ID = process.env.ASSISTANT_ID;
if (!ASSISTANT_ID) {
    throw new Error("Missing ASSISTANT_ID environment variable.");
}

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
});

// Creates a new chat thread.
app.post(`/chat/new`, async (req, res) => {
    try {
        const thread = await openai.beta.threads.create();
        res.json({ threadId: thread.id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to create thread" });
    }
});

// Sends a new chat message.
app.post(`/chat/send`, async (req, res) => {
    try {
        const { threadId, text } = req.body;
    
        await openai.beta.threads.messages.create(threadId, {
            role: "user",
            content: text,
        });
    
        const run = await openai.beta.threads.runs.create(threadId, {
            assistant_id: ASSISTANT_ID,
        });
    
        res.json({ runId: run.id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to send message" });
    }
});

// Lists messages for a particular thread.
app.post(`/chat/list`, async (req, res) => {
    try {
        const { threadId, runId } = req.body;
    
        const messages = await openai.beta.threads.messages.list(threadId);
    
        let status;
        if (runId) {
            const run = await openai.beta.threads.runs.retrieve(threadId, runId);
            status = run.status;
        }
    
        res.json({ messages: messages.data, status });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to list messages" });
    }
});


// Create a nodemailer transporter using SMTP
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST, // e.g., "smtp.gmail.com"
    port: process.env.SMTP_PORT, // e.g., 587
    secure: process.env.SMTP_SECURE === "true", // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER, // your email address
      pass: process.env.SMTP_PASS, // your email password or app-specific password
    },
});

// Verify connection configuration
transporter.verify(function (error, success) {
    if (error) {
        console.error("Error with email transporter:", error);
    } else {
        console.log("Email transporter is ready to send messages");
    }
});

// POST /api/contact endpoint to handle form submissions
app.post("/api/contact", async (req, res) => {
    const { name, email, message } = req.body;

    // Basic validation
    if (!name || !email || !message) {
        return res.status(400).json({ error: "Please fill in all fields" });
    }

    const mailOptions = {
        from: `"Website Contact" <${process.env.SMTP_USER}>`, // sender address
        to: process.env.CONTACT_EMAIL, // your email address where you receive messages
        subject: `New Contact Message from ${name}`,
        text: `
            Name: ${name}
            Email: ${email}
            Message: ${message}
        `,
        // Optionally, you can add an HTML body:
        html: `
            <h2>New Contact Message</h2>
            <p><strong>Name:</strong> ${name}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Message:</strong></p>
            <p>${message}</p>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        res.json({ message: "Email sent successfully" });
    } catch (error) {
        console.error("Error sending email:", error);
        res.status(500).json({ error: "Error sending email" });
        }
});



// API Route to get all projects
app.get('/api/projects', async (req, res) => {
    try {
        // SQL Query: fetch all projects ordered by rank
        const queryText = 'SELECT * FROM projects ORDER BY rank';
        const { rows } = await pool.query(queryText);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching projects:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Optional: A route to get a single project by id
app.get('/api/projects/:id', async (req, res) => {
    try {
        const queryText = 'SELECT * FROM projects WHERE id = $1';
        const { rows } = await pool.query(queryText, [req.params.id]);
        if (rows.length === 0) {
        return res.status(404).json({ error: 'Project not found' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error('Error fetching project:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post("/api/projects", isAuthenticatedAndAdmin, async (req, res) => {
    const {
        name,
        type,
        image,      
        images,     
        complexity,
        year,
        languages,
        description,
        github,
    } = req.body;
    
    try {
        const insertQuery = `
            INSERT INTO projects
            (name, type, image, images, rank, year, languages, description, github)
            VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *;
        `;
        
        const { rows } = await pool.query(insertQuery, [
            name,
            type,
            image,
            JSON.stringify(images),
            complexity,
            year,
            languages,
            description,
            github,
        ]);
    
        res.json(rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
});


app.patch("/api/projects/:id", isAuthenticatedAndAdmin, async (req, res) => {
    const { id } = req.params;
    const {
        name,
        type,
        image,
        images,
        complexity,
        year,
        languages,
        description,
        github,
    } = req.body;
    
    try {
        const updateQuery = `
            UPDATE projects
            SET
            name = $1,
            type = $2,
            image = $3,
            images = $4,
            rank = $5,
            year = $6,
            languages = $7,
            description = $8,
            github = $9
            WHERE id = $10
            RETURNING *;
        `;
        const { rows } = await pool.query(updateQuery, [
            name,
            type,
            image,
            JSON.stringify(images),
            complexity,
            year,
            languages,
            description,
            github,
            id,
        ]);
    
        if (rows.length === 0) {
            return res.status(404).json({ message: "Project not found" });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
});

app.delete("/api/projects/:id", isAuthenticatedAndAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const deleteQuery = "DELETE FROM projects WHERE id = $1 RETURNING *";
        const { rows } = await pool.query(deleteQuery, [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: "Project not found" });
        }
        res.json({ message: "Project deleted successfully", project: rows[0] });
    } catch (error) {
        console.error("Error deleting project:", error);
        res.status(500).json({ message: "Server error" });
    }
});

app.get('/api/work-experiences', async (req, res) => {
    try {
        const queryText = 'SELECT * FROM work_experiences ORDER BY end_date DESC';
        const { rows } = await pool.query(queryText);
        // Convert JSONB details to JavaScript arrays
        const formatted = rows.map((row) => ({
            ...row,
            details: row.details, // JSON is automatically parsed by pg in many setups
        }));
        res.json(formatted);
    } catch (error) {
        console.error('Error fetching work experiences:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});