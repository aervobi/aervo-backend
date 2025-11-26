<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Aervo – Sign up</title>
  <link rel="icon" type="image/png" href="favicon.png" />

  <style>
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #050817;
      color: #d6def8;
    }

    .nav {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 40px;
      background: rgba(5, 8, 23, 0.92);
      backdrop-filter: blur(14px);
      z-index: 10;
      border-bottom: 1px solid rgba(255, 255, 255, 0.03);
    }

    .nav-brand {
      font-weight: 600;
      letter-spacing: 4px;
      font-size: 14px;
      color: #8fbfff;
    }

    .nav-links a {
      margin: 0 12px;
      font-size: 14px;
      text-decoration: none;
      color: #a6b3dd;
    }

    .nav-links a:hover {
      color: #dfe7ff;
    }

    .nav-login-btn {
      padding: 8px 16px;
      border-radius: 999px;
      border: 1px solid #3a4a7c;
      text-decoration: none;
      font-size: 14px;
      color: #dfe7ff;
    }

    .nav-login-btn:hover {
      background: #1a2237;
    }

    main {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding-top: 64px;
    }

    .card {
      background: radial-gradient(circle at top left, #1a2237, #050817);
      border-radius: 18px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
      padding: 32px 28px 28px;
      width: 100%;
      max-width: 380px;
    }

    .card h1 {
      margin: 0 0 4px;
      font-size: 24px;
      color: #e5ecff;
    }

    .card p {
      margin: 0 0 24px;
      font-size: 14px;
      color: #9ca7d6;
    }

    label {
      display: block;
      font-size: 13px;
      margin-bottom: 6px;
      color: #c5cff6;
    }

    input {
      width: 100%;
      padding: 10px 11px;
      margin-bottom: 14px;
      border-radius: 8px;
      border: 1px solid #323a5c;
      background: #050817;
      color: #e5ecff;
      font-size: 14px;
      box-sizing: border-box;
    }

    input:focus {
      outline: none;
      border-color: #6e9bff;
      box-shadow: 0 0 0 1px rgba(110, 155, 255, 0.5);
    }

    button {
      width: 100%;
      padding: 11px 0;
      border-radius: 10px;
      border: none;
      background: #1a243d;
      color: #b4cdff;
      font-size: 15px;
      letter-spacing: 0.5px;
      cursor: pointer;
      box-shadow:
        0 0 12px rgba(137, 180, 255, 0.4),
        0 0 26px rgba(80, 130, 255, 0.3);
      transition: all 0.2s ease;
    }

    button:hover {
      background: #222c48;
      transform: translateY(-1px);
      box-shadow:
        0 0 16px rgba(137, 180, 255, 0.8),
        0 0 40px rgba(80, 130, 255, 0.6);
    }

    .error {
      margin-top: 8px;
      font-size: 13px;
      color: #ff7b7b;
      min-height: 18px;
    }

    .helper {
      font-size: 12px;
      color: #8b94c0;
      margin-top: 10px;
      line-height: 1.5;
    }

    .helper a {
      color: #bcd3ff;
      text-decoration: underline;
    }

    @media (max-width: 768px) {
      .nav {
        padding: 0 16px;
        height: 56px;
      }

      .nav-links {
        display: none;
      }

      main {
        padding: 80px 16px 24px;
      }

      .card {
        padding: 24px 20px 20px;
      }
    }
  </style>
</head>
<body>
  <header class="nav">
    <div class="nav-left">
      <span class="nav-brand">AERVO</span>
    </div>
    <nav class="nav-links">
      <a href="index.html#product">Product</a>
      <a href="index.html#pricing">Pricing</a>
    </nav>
    <div class="nav-right">
      <a href="login.html" class="nav-login-btn">Log in</a>
    </div>
  </header>

  <main>
    <div class="card">
      <h1>Create your account</h1>
      <p>Set up Aervo for your business in a few seconds.</p>

      <form id="signup-form">
        <label for="companyName">Business name</label>
        <input id="companyName" type="text" required placeholder="Luna Coffee Co." />

        <label for="email">Work email</label>
        <input id="email" type="email" required placeholder="you@business.com" />

        <label for="password">Password</label>
        <input id="password" type="password" required placeholder="••••••••" />

        <button type="submit">Create account</button>

        <div class="error" id="error"></div>

        <div class="helper">
          Already have an account?
          <a href="login.html">Log in</a>
        </div>
      </form>
    </div>
  </main>

  <script>
    const BACKEND_URL = "https://aervo-backend.onrender.com";

    document
      .getElementById("signup-form")
      .addEventListener("submit", handleSignup);

    async function handleSignup(event) {
      event.preventDefault();

      const companyName = document.getElementById("companyName").value.trim();
      const email = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value.trim();
      const errorEl = document.getElementById("error");

      errorEl.textContent = "";

      try {
        const response = await fetch(`${BACKEND_URL}/api/signup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, companyName })
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          errorEl.textContent =
            data.message || "Could not create your account. Please try again.";
          return;
        }

        // store token + user (same keys as login)
        localStorage.setItem("aervo_token", data.token);
        localStorage.setItem("aervo_user", JSON.stringify(data.user));
        localStorage.setItem("aervoUser", JSON.stringify(data.user));

        // go straight to dashboard
        window.location.href = "dashboard.html";
      } catch (err) {
        console.error(err);
        errorEl.textContent = "Error connecting to server. Please try again.";
      }
    }
  </script>
</body>
</html>