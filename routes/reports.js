const express = require("express");
const router = express.Router();
const Anthropic = require("@anthropic-ai/sdk");

module.exports = (pool, authenticateToken) => {

  // ── Helper: get shop access token ──────────────────────────
  async function getShopToken(shopOrigin, userId) {
    const result = await pool.query(
      `SELECT access_token FROM shops 
       WHERE shop_origin = $1 AND (user_id = $2 OR user_id IS NULL)`,
      [shopOrigin, userId]
    );
    if (result.rows.length === 0) throw new Error("Shop not found or access denied");
    return result.rows[0].access_token;
  }

  // ── POST /api/reports/generate ──────────────────────────────
  router.post("/api/reports/generate", authenticateToken, async (req, res) => {
    try {
      const { reportType, dateRange, shopOrigin } = req.body;

      if (!reportType || !shopOrigin) {
        return res.status(400).json({ success: false, message: "reportType and shopOrigin are required" });
      }

      const accessToken = await getShopToken(shopOrigin, req.user.userId);
      const apiVersion = process.env.SHOPIFY_API_VERSION || "2024-01";
      const base = `https://${shopOrigin}/admin/api/${apiVersion}`;
      const h = { "X-Shopify-Access-Token": accessToken };

      // Calculate date range
      const endDate = new Date();
      let startDate = new Date();
      switch (dateRange) {
        case "7d":  startDate.setDate(startDate.getDate() - 7); break;
        case "30d": startDate.setDate(startDate.getDate() - 30); break;
        case "90d": startDate.setDate(startDate.getDate() - 90); break;
        case "1y":  startDate.setFullYear(startDate.getFullYear() - 1); break;
        default:    startDate.setDate(startDate.getDate() - 30);
      }

      const startISO = startDate.toISOString();

      // Fetch data based on report type
      let reportData = {};
      let aiPrompt = "";

      if (reportType === "revenue") {
        const ordersRes = await fetch(
          `${base}/orders.json?status=any&limit=250&created_at_min=${startISO}`,
          { headers: h }
        );
        const orders = (await ordersRes.json()).orders || [];

        // Daily breakdown
        const daily = {};
        orders.forEach(o => {
          const day = o.created_at.split("T")[0];
          if (!daily[day]) daily[day] = { date: day, revenue: 0, orders: 0 };
          daily[day].revenue += parseFloat(o.total_price || 0);
          daily[day].orders += 1;
        });

        const totalRevenue = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
        const avgOrderValue = orders.length ? totalRevenue / orders.length : 0;
        const dailyAvg = totalRevenue / Math.max(Object.keys(daily).length, 1);

        reportData = {
          title: "Revenue Report",
          metrics: [
            { label: "Total Revenue", value: `$${totalRevenue.toFixed(2)}`, color: "green" },
            { label: "Total Orders", value: orders.length, color: "blue" },
            { label: "Avg Order Value", value: `$${avgOrderValue.toFixed(2)}`, color: "purple" },
            { label: "Daily Average", value: `$${dailyAvg.toFixed(2)}`, color: "cyan" },
          ],
          chartData: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)).map(d => ({
            label: new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
            value: parseFloat(d.revenue.toFixed(2)),
            secondary: d.orders
          })),
          tableHeaders: ["Date", "Orders", "Revenue"],
          tableRows: Object.values(daily).sort((a, b) => b.date.localeCompare(a.date)).map(d => [
            new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
            d.orders,
            `$${d.revenue.toFixed(2)}`
          ])
        };

        aiPrompt = `Analyze this revenue data for a Shopify store (${dateRange} period):
Total Revenue: $${totalRevenue.toFixed(2)}
Total Orders: ${orders.length}
Average Order Value: $${avgOrderValue.toFixed(2)}
Daily Average Revenue: $${dailyAvg.toFixed(2)}
Daily breakdown: ${JSON.stringify(Object.values(daily).slice(-7))}

Write a 3-4 sentence business insight paragraph. Be specific, actionable, and conversational. Mention trends, highlight wins or concerns, and suggest one concrete action.`;

      } else if (reportType === "orders") {
        const ordersRes = await fetch(
          `${base}/orders.json?status=any&limit=250&created_at_min=${startISO}`,
          { headers: h }
        );
        const orders = (await ordersRes.json()).orders || [];

        const statusBreakdown = {};
        orders.forEach(o => {
          const s = o.financial_status || "unknown";
          statusBreakdown[s] = (statusBreakdown[s] || 0) + 1;
        });

        const fulfilled = orders.filter(o => o.fulfillment_status === "fulfilled").length;
        const pending = orders.filter(o => !o.fulfillment_status).length;
        const totalRevenue = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
        const avgOrderValue = orders.length ? totalRevenue / orders.length : 0;

        reportData = {
          title: "Orders Report",
          metrics: [
            { label: "Total Orders", value: orders.length, color: "blue" },
            { label: "Fulfilled", value: fulfilled, color: "green" },
            { label: "Pending", value: pending, color: "yellow" },
            { label: "Avg Order Value", value: `$${avgOrderValue.toFixed(2)}`, color: "purple" },
          ],
          chartData: Object.entries(statusBreakdown).map(([label, value]) => ({ label, value })),
          tableHeaders: ["Order #", "Date", "Customer", "Status", "Total"],
          tableRows: orders.slice(0, 50).map(o => [
            `#${o.order_number}`,
            new Date(o.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
            o.customer ? `${o.customer.first_name || ""} ${o.customer.last_name || ""}`.trim() || "Guest" : "Guest",
            o.financial_status || "—",
            `$${parseFloat(o.total_price || 0).toFixed(2)}`
          ])
        };

        aiPrompt = `Analyze this orders data for a Shopify store (${dateRange} period):
Total Orders: ${orders.length}
Fulfilled: ${fulfilled}
Pending Fulfillment: ${pending}
Status Breakdown: ${JSON.stringify(statusBreakdown)}
Average Order Value: $${avgOrderValue.toFixed(2)}

Write a 3-4 sentence business insight paragraph. Be specific and actionable.`;

      } else if (reportType === "refunds") {
        const ordersRes = await fetch(
          `${base}/orders.json?status=any&limit=250&created_at_min=${startISO}`,
          { headers: h }
        );
        const orders = (await ordersRes.json()).orders || [];
        const refunded = orders.filter(o => o.financial_status === "refunded" || o.financial_status === "partially_refunded");
        const totalRevenue = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
        const totalRefunded = refunded.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
        const refundRate = orders.length ? ((refunded.length / orders.length) * 100) : 0;

        reportData = {
          title: "Refund Report",
          metrics: [
            { label: "Total Refunds", value: refunded.length, color: "red" },
            { label: "Refund Rate", value: `${refundRate.toFixed(1)}%`, color: "yellow" },
            { label: "Amount Refunded", value: `$${totalRefunded.toFixed(2)}`, color: "red" },
            { label: "Total Orders", value: orders.length, color: "blue" },
          ],
          chartData: [
            { label: "Refunded", value: refunded.length },
            { label: "Non-Refunded", value: orders.length - refunded.length }
          ],
          tableHeaders: ["Order #", "Date", "Customer", "Status", "Amount"],
          tableRows: refunded.slice(0, 50).map(o => [
            `#${o.order_number}`,
            new Date(o.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
            o.customer ? `${o.customer.first_name || ""} ${o.customer.last_name || ""}`.trim() || "Guest" : "Guest",
            o.financial_status,
            `$${parseFloat(o.total_price || 0).toFixed(2)}`
          ])
        };

        aiPrompt = `Analyze this refund data for a Shopify store (${dateRange} period):
Total Orders: ${orders.length}
Refunded Orders: ${refunded.length}
Refund Rate: ${refundRate.toFixed(1)}%
Total Amount Refunded: $${totalRefunded.toFixed(2)}
Total Revenue: $${totalRevenue.toFixed(2)}

Write a 3-4 sentence business insight paragraph about the refund situation. Be specific and actionable. If refund rate is high, suggest investigation. If low, acknowledge it.`;

      } else if (reportType === "inventory") {
        const productsRes = await fetch(`${base}/products.json?limit=250`, { headers: h });
        const products = (await productsRes.json()).products || [];
        const variants = products.flatMap(p => p.variants.map(v => ({ ...v, productTitle: p.title })));
        const outOfStock = variants.filter(v => (v.inventory_quantity || 0) === 0);
        const lowStock = variants.filter(v => (v.inventory_quantity || 0) > 0 && (v.inventory_quantity || 0) <= 10);
        const inStock = variants.filter(v => (v.inventory_quantity || 0) > 10);
        const totalValue = variants.reduce((s, v) => s + (parseFloat(v.price || 0) * Math.max(v.inventory_quantity || 0, 0)), 0);

        reportData = {
          title: "Inventory Report",
          metrics: [
            { label: "Total Products", value: products.length, color: "blue" },
            { label: "Out of Stock", value: outOfStock.length, color: "red" },
            { label: "Low Stock", value: lowStock.length, color: "yellow" },
            { label: "Inventory Value", value: `$${totalValue.toFixed(2)}`, color: "green" },
          ],
          chartData: [
            { label: "In Stock", value: inStock.length },
            { label: "Low Stock", value: lowStock.length },
            { label: "Out of Stock", value: outOfStock.length },
          ],
          tableHeaders: ["Product", "Variant", "SKU", "Quantity", "Status"],
          tableRows: [...outOfStock, ...lowStock, ...inStock.slice(0, 30)].map(v => [
            v.productTitle,
            v.title !== "Default Title" ? v.title : "—",
            v.sku || "—",
            v.inventory_quantity || 0,
            (v.inventory_quantity || 0) === 0 ? "Out of Stock" : (v.inventory_quantity || 0) <= 10 ? "Low Stock" : "In Stock"
          ])
        };

        aiPrompt = `Analyze this inventory data for a Shopify store:
Total Products: ${products.length}
Out of Stock: ${outOfStock.length}
Low Stock (≤10 units): ${lowStock.length}
In Stock: ${inStock.length}
Total Inventory Value: $${totalValue.toFixed(2)}
Out of Stock Items: ${outOfStock.slice(0, 5).map(v => v.productTitle).join(", ")}

Write a 3-4 sentence business insight paragraph. Highlight urgency for out of stock items, flag low stock risks, and suggest reorder strategy.`;

      } else if (reportType === "customers") {
        const customersRes = await fetch(`${base}/customers.json?limit=250`, { headers: h });
        const customers = (await customersRes.json()).customers || [];
        const ordersRes = await fetch(
          `${base}/orders.json?status=any&limit=250&created_at_min=${startISO}`,
          { headers: h }
        );
        const orders = (await ordersRes.json()).orders || [];
        const newCustomers = customers.filter(c => new Date(c.created_at) >= startDate);
        const repeatCustomers = customers.filter(c => (c.orders_count || 0) > 1);
        const totalSpent = customers.reduce((s, c) => s + parseFloat(c.total_spent || 0), 0);
        const avgLifetimeValue = customers.length ? totalSpent / customers.length : 0;

        const topCustomers = [...customers]
          .sort((a, b) => parseFloat(b.total_spent || 0) - parseFloat(a.total_spent || 0))
          .slice(0, 20);

        reportData = {
          title: "Customer Report",
          metrics: [
            { label: "Total Customers", value: customers.length, color: "blue" },
            { label: "New Customers", value: newCustomers.length, color: "green" },
            { label: "Repeat Customers", value: repeatCustomers.length, color: "purple" },
            { label: "Avg Lifetime Value", value: `$${avgLifetimeValue.toFixed(2)}`, color: "cyan" },
          ],
          chartData: [
            { label: "New", value: newCustomers.length },
            { label: "Returning", value: repeatCustomers.length },
            { label: "One-time", value: customers.length - repeatCustomers.length - newCustomers.length }
          ],
          tableHeaders: ["Customer", "Email", "Orders", "Total Spent"],
          tableRows: topCustomers.map(c => [
            `${c.first_name || ""} ${c.last_name || ""}`.trim() || "Guest",
            c.email || "—",
            c.orders_count || 0,
            `$${parseFloat(c.total_spent || 0).toFixed(2)}`
          ])
        };

        aiPrompt = `Analyze this customer data for a Shopify store (${dateRange} period):
Total Customers: ${customers.length}
New Customers This Period: ${newCustomers.length}
Repeat Customers: ${repeatCustomers.length} (${customers.length ? ((repeatCustomers.length / customers.length) * 100).toFixed(1) : 0}%)
Average Lifetime Value: $${avgLifetimeValue.toFixed(2)}

Write a 3-4 sentence business insight paragraph. Focus on customer retention, acquisition trends, and one actionable recommendation.`;

      } else if (reportType === "products") {
        const ordersRes = await fetch(
          `${base}/orders.json?status=any&limit=250&created_at_min=${startISO}`,
          { headers: h }
        );
        const orders = (await ordersRes.json()).orders || [];

        const productSales = {};
        orders.forEach(order => {
          (order.line_items || []).forEach(item => {
            if (!productSales[item.product_id]) {
              productSales[item.product_id] = { name: item.title, units: 0, revenue: 0 };
            }
            productSales[item.product_id].units += item.quantity;
            productSales[item.product_id].revenue += parseFloat(item.price) * item.quantity;
          });
        });

        const sorted = Object.values(productSales).sort((a, b) => b.revenue - a.revenue);
        const top10 = sorted.slice(0, 10);
        const bottom10 = sorted.slice(-10).reverse();

        reportData = {
          title: "Product Performance Report",
          metrics: [
            { label: "Products Sold", value: Object.keys(productSales).length, color: "blue" },
            { label: "Total Units", value: sorted.reduce((s, p) => s + p.units, 0), color: "green" },
            { label: "Top Product", value: sorted[0]?.name?.slice(0, 20) || "—", color: "purple" },
            { label: "Top Revenue", value: sorted[0] ? `$${sorted[0].revenue.toFixed(2)}` : "—", color: "cyan" },
          ],
          chartData: top10.map(p => ({ label: p.name.slice(0, 20), value: parseFloat(p.revenue.toFixed(2)) })),
          tableHeaders: ["Product", "Units Sold", "Revenue", "Avg Price"],
          tableRows: sorted.slice(0, 50).map(p => [
            p.name,
            p.units,
            `$${p.revenue.toFixed(2)}`,
            `$${(p.revenue / p.units).toFixed(2)}`
          ])
        };

        aiPrompt = `Analyze this product performance data for a Shopify store (${dateRange} period):
Top Products: ${top10.slice(0, 5).map(p => `${p.name}: ${p.units} units, $${p.revenue.toFixed(2)}`).join("; ")}
Worst Performers: ${bottom10.slice(0, 3).map(p => `${p.name}: ${p.units} units, $${p.revenue.toFixed(2)}`).join("; ")}
Total Products Sold: ${Object.keys(productSales).length}

Write a 3-4 sentence business insight paragraph. Highlight what's working, what's underperforming, and one specific recommendation.`;

      } else if (reportType === "pnl") {
        const ordersRes = await fetch(
          `${base}/orders.json?status=any&limit=250&created_at_min=${startISO}`,
          { headers: h }
        );
        const orders = (await ordersRes.json()).orders || [];
        const totalRevenue = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
        const totalDiscounts = orders.reduce((s, o) => s + parseFloat(o.total_discounts || 0), 0);
        const totalTax = orders.reduce((s, o) => s + parseFloat(o.total_tax || 0), 0);
        const refunded = orders.filter(o => o.financial_status === "refunded" || o.financial_status === "partially_refunded");
        const totalRefunds = refunded.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
        const netRevenue = totalRevenue - totalRefunds - totalDiscounts;

        // Monthly breakdown
        const monthly = {};
        orders.forEach(o => {
          const m = o.created_at.slice(0, 7);
          if (!monthly[m]) monthly[m] = { month: m, revenue: 0, discounts: 0, refunds: 0 };
          monthly[m].revenue += parseFloat(o.total_price || 0);
          monthly[m].discounts += parseFloat(o.total_discounts || 0);
          if (o.financial_status === "refunded" || o.financial_status === "partially_refunded") {
            monthly[m].refunds += parseFloat(o.total_price || 0);
          }
        });

        reportData = {
          title: "Profit & Loss Summary",
          metrics: [
            { label: "Gross Revenue", value: `$${totalRevenue.toFixed(2)}`, color: "green" },
            { label: "Total Discounts", value: `-$${totalDiscounts.toFixed(2)}`, color: "yellow" },
            { label: "Total Refunds", value: `-$${totalRefunds.toFixed(2)}`, color: "red" },
            { label: "Net Revenue", value: `$${netRevenue.toFixed(2)}`, color: "cyan" },
          ],
          chartData: Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month)).map(m => ({
            label: new Date(m.month + "-01").toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
            value: parseFloat((m.revenue - m.discounts - m.refunds).toFixed(2))
          })),
          tableHeaders: ["Month", "Gross Revenue", "Discounts", "Refunds", "Net Revenue"],
          tableRows: Object.values(monthly).sort((a, b) => b.month.localeCompare(a.month)).map(m => [
            new Date(m.month + "-01").toLocaleDateString("en-US", { month: "long", year: "numeric" }),
            `$${m.revenue.toFixed(2)}`,
            `-$${m.discounts.toFixed(2)}`,
            `-$${m.refunds.toFixed(2)}`,
            `$${(m.revenue - m.discounts - m.refunds).toFixed(2)}`
          ])
        };

        aiPrompt = `Analyze this P&L data for a Shopify store (${dateRange} period):
Gross Revenue: $${totalRevenue.toFixed(2)}
Total Discounts: $${totalDiscounts.toFixed(2)}
Total Refunds: $${totalRefunds.toFixed(2)}
Net Revenue: $${netRevenue.toFixed(2)}
Tax Collected: $${totalTax.toFixed(2)}

Write a 3-4 sentence business insight paragraph. Comment on discount strategy, refund impact, and net revenue health. Be specific and actionable.`;
      }

      // Generate AI insights
      let aiInsights = "";
      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const aiResponse = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 300,
          system: "You are Aervo, an expert business analyst. Write clear, specific, actionable business insights based on real store data. Be conversational but professional. Never use bullet points — write in flowing paragraphs.",
          messages: [{ role: "user", content: aiPrompt }]
        });
        aiInsights = aiResponse.content[0]?.text || "";
      } catch (aiErr) {
        console.error("AI insights error:", aiErr);
        aiInsights = "AI insights temporarily unavailable.";
      }

      return res.json({
        success: true,
        report: {
          ...reportData,
          aiInsights,
          dateRange,
          generatedAt: new Date().toISOString(),
          shopOrigin
        }
      });

    } catch (err) {
      console.error("Report generation error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  return router;
};