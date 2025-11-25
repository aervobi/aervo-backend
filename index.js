const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

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