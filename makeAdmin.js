require ("dotenv").congfig();

const express = require("express");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const path = require("path");

// Routes
const authRoutes = require("./routes/auth");
const movieRoutes = require("./routes/movies");
const showRoutes = require("./routes/shows");
const bookingRoutes = require("./routes/bookings");
const adminRoutes = require("./routes/admin");

const app = express();
app.use(express.json());
app.use(cookieParser());

app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// API ROUTES
// ==========================================
app.use("/api/auth", authRoutes);
app.use("/api/movies", movieRoutes);
app.use("/api/shows", showRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/admin", adminRoutes);

// ==========================================
// HEALTH CHECK
// ==========================================
app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        app: "CineBook Pro"
    });
});

// ==========================================
// FRONTEND FALLBACK
// ==========================================
app.use((req, res, next) => {
    if (req.method !== "GET") {
        return next();
    }

    if (req.path.startsWith("/api/")) {
        return res.status(404).json({
            success: false,
            message: "API endpoint not found"
        });
    }
    res.sendFile(
      path.join(__dirname, "public", "index.html"),
      (err) => {
        if (err) {
          next(err);
        }
      }
    );
});
app.use((err, req, res, next) => {
    console.error("Server Error:", err);

    res.status(500).json({
        success: false,
        message: "Internal server error"
    });
});

// ==========================================
// PORT
// ==========================================
const PORT = process.env.PORT || 5000;

// ==========================================
// MONGODB CONNECTION
// ==========================================
const MONGO_URI =
    process.env.MONGO_URI ||
    "mongodb://127.0.0.1:27017/cinebook_pro";

mongoose
    .connect(MONGO_URI)
    .then(() => {
        console.log("MongoDB connected successfully");

        app.listen(PORT, () => {
            console.log(
                `CineBook Pro running at http://localhost:${PORT}`
            );
        });
    })
    .catch((err) => {
        console.error(
            "MongoDB connection failed:",
            err.message
        );

        process.exit(1);
    });
    }
