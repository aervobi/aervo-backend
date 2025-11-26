const express = require("express");
const cors = require("cors");       // ⬅️ add this line

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());                    // ⬅️ add this line so any origin (like aervoapp.com) can call your API

// Simple health check route
app.get("/health", (req, res) => {
  res.json({ status: "ok", app: "Aervo backend" });
});

// Root route
app.get("/", (req, res) => {
  res.send("Aervo backend is running");
});

app.listen(PORT, () => {
  console.log(`Aervo backend listening on port ${PORT}`);
});