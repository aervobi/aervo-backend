const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

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
// Demo login user
const DEMO_USER = {
  email: 'demo@aervo.com',
  password: 'demo123',
  name: 'Luna Coffee Co.',
  role: 'Owner'
};

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};

  if (email === DEMO_USER.email && password === DEMO_USER.password) {
    return res.json({
      success: true,
      token: 'aervo-demo-token',
      user: {
        name: DEMO_USER.name,
        role: DEMO_USER.role,
        email: DEMO_USER.email
      }
    });
  }

  return res.status(401).json({
    success: false,
    message: 'Invalid email or password.'
  });
});
app.listen(10000, () => {
  console.log('Server running on port 10000');
});