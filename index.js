const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());

app.get('/', (req, res) => {
  res.send('Aervo backend is running!');
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Aervo backend',
    environment: process.env.NODE_ENV || 'development'
  });
});

app.listen(10000, () => {
  console.log('Server running on port 10000');
});