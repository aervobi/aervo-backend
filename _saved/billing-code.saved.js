// Create a charge for a plan
router.post("/billing/create", async (req, res) => {
  try {
    const { shop, plan } = req.body;
    if (!shop || !plan || !PLANS_CONFIG[plan]) {
      return res.status(400).json({ success: false, message: "Invalid plan or shop" });
    }

    const shopResult = await pool.query(
      "SELECT access_token FROM shops WHERE shop_origin = $1",
      [shop]
    );
    if (shopResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Shop not found" });
    }

    const accessToken = shopResult.rows[0].access_token;
    const planConfig = PLANS_CONFIG[plan];
    const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-10";

    const response = await fetch(
      `https://${shop}/admin/api/${apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `
            mutation appSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!, $test: Boolean) {
              appSubscriptionCreate(name: $name, lineItems: $lineItems, returnUrl: $returnUrl, test: $test) {
                userErrors { field message }
                appSubscription { id }
                confirmationUrl
              }
            }
          `,
          variables: {
            name: planConfig.name,
            returnUrl: `${APP_URL}/auth/shopify/billing/callback?shop=${shop}&plan=${plan}`,
            test: process.env.NODE_ENV !== "production",
            lineItems: [{
              plan: {
                appRecurringPricingDetails: {
                  price: { amount: planConfig.price, currencyCode: "USD" },
                  interval: "EVERY_30_DAYS"
                }
              }
            }]
          }
        }),
      }
    );

    const text = await response.text();
    console.log("Billing GraphQL response:", response.status, text);
    const data = JSON.parse(text);
    const result = data.data?.appSubscriptionCreate;

    if (result?.userErrors?.length > 0) {
      console.error("Billing user errors:", result.userErrors);
      return res.status(500).json({ success: false, message: result.userErrors[0].message });
    }

    if (!result?.confirmationUrl) {
      return res.status(500).json({ success: false, message: "Failed to create charge" });
    }

    return res.json({ success: true, confirmationUrl: result.confirmationUrl });
  } catch (err) {
    console.error("Billing create error:", err);
    return res.status(500).json({ success: false, message: "Billing failed" });
  }
});

// Callback after merchant approves charge
router.get("/billing/callback", async (req, res) => {
  try {
    const { shop, plan, charge_id } = req.query;

    if (!shop || !plan) {
      return res.status(400).send("Missing billing parameters");
    }

    // Update user plan
    await pool.query(
      `UPDATE users SET plan = $1 WHERE id = (
        SELECT user_id FROM shops WHERE shop_origin = $2
      )`,
      [plan, shop]
    );

    return res.send(`
      <html>
        <script>
          window.top.location.href = '${FRONTEND_URL}/dashboard/shopify?billing=success&plan=${plan}';
        </script>
      </html>
    `);
  } catch (err) {
    console.error("Billing callback error:", err);
    return res.send(`
      <html>
        <script>
          window.top.location.href = '${FRONTEND_URL}/dashboard/shopify?billing=failed';
        </script>
      </html>
    `);
  }
});