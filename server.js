require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const app = express();

const PORT = process.env.PORT || 10000;
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  `http://localhost:${PORT}`;

const GATEPAY_API = "https://api.gatepay.to/pay.php";
const GATEPAY_WALLET = process.env.GATEPAY_WALLET_ADDRESS || "";
const GATEPAY_CURRENCY = process.env.GATEPAY_CURRENCY || "EUR";

const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function file(name) {
  return path.join(DATA_DIR, name);
}

function readJSON(name, fallback) {
  try {
    const p = file(name);

    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, JSON.stringify(fallback, null, 2));
      return fallback;
    }

    const data = fs.readFileSync(p, "utf8");

    if (!data.trim()) return fallback;

    return JSON.parse(data);
  } catch (e) {
    console.error("readJSON:", name, e.message);
    return fallback;
  }
}

function writeJSON(name, data) {
  fs.writeFileSync(
    file(name),
    JSON.stringify(data, null, 2)
  );
}

const orders = readJSON("orders.json", []);
const products = readJSON("products.json", []);
const reviews = readJSON("reviews.json", []);
const subscribers = readJSON("subscribers.json", []);
const productViews = readJSON("product-views.json", []);

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*"
  })
);

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb"
  })
);

/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "MERCADO",
    payment: "GatePay.to",
    currency: GATEPAY_CURRENCY,
    gatepayConfigured: Boolean(GATEPAY_WALLET),
    time: new Date().toISOString()
  });
});

/* =========================================================
   EMAIL
========================================================= */

let mailTransporter = null;

if (
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure:
      String(process.env.SMTP_SECURE || "true") === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

async function sendEmail({
  to,
  subject,
  html,
  text
}) {
  if (!to) return false;

  /* Resend */
  if (process.env.RESEND_API_KEY) {
    try {
      const response = await fetch(
        "https://api.resend.com/emails",
        {
          method: "POST",
          headers: {
            Authorization:
              `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from:
              process.env.RESEND_FROM ||
              "MERCADO <onboarding@resend.dev>",
            to: [to],
            subject,
            html,
            text
          })
        }
      );

      if (response.ok) return true;

      console.error(
        "Resend error:",
        await response.text()
      );
    } catch (e) {
      console.error("Resend:", e.message);
    }
  }

  /* SMTP */
  if (mailTransporter) {
    try {
      await mailTransporter.sendMail({
        from:
          process.env.SMTP_FROM ||
          process.env.SMTP_USER,
        to,
        subject,
        html,
        text
      });

      return true;
    } catch (e) {
      console.error("SMTP:", e.message);
    }
  }

  return false;
}

/* =========================================================
   EMAIL VERIFICATION
========================================================= */

const emailCodes = new Map();

app.post("/api/email/send", async (req, res) => {
  const email = String(req.body.email || "")
    .trim()
    .toLowerCase();

  if (!email || !email.includes("@")) {
    return res.status(400).json({
      error: "Email invalide"
    });
  }

  const code = String(
    Math.floor(1000 + Math.random() * 9000)
  );

  emailCodes.set(email, {
    code,
    expiresAt: Date.now() + 10 * 60 * 1000
  });

  const sent = await sendEmail({
    to: email,
    subject: "Votre code MERCADO",
    text:
      `Votre code de vérification MERCADO est ${code}. ` +
      `Il expire dans 10 minutes.`,
    html: `
      <div style="font-family:Arial">
        <h2>MERCADO</h2>
        <p>Votre code de vérification :</p>
        <h1>${code}</h1>
        <p>Ce code expire dans 10 minutes.</p>
      </div>
    `
  });

  /*
    En développement, on ne bloque pas le compte
    si aucun service email n'est configuré.
  */

  res.json({
    ok: true,
    sent,
    message: sent
      ? "Code envoyé"
      : "Service email non configuré"
  });
});

app.post("/api/email/verify", (req, res) => {
  const email = String(req.body.email || "")
    .trim()
    .toLowerCase();

  const code = String(req.body.code || "").trim();

  const record = emailCodes.get(email);

  if (!record) {
    return res.status(400).json({
      verified: false,
      error: "Code introuvable"
    });
  }

  if (Date.now() > record.expiresAt) {
    emailCodes.delete(email);

    return res.status(400).json({
      verified: false,
      error: "Code expiré"
    });
  }

  if (record.code !== code) {
    return res.status(400).json({
      verified: false,
      error: "Code incorrect"
    });
  }

  emailCodes.delete(email);

  res.json({
    verified: true
  });
});

/* =========================================================
   LOCAL PRODUCTS
========================================================= */

app.get("/api/products", (req, res) => {
  res.json({
    products
  });
});

/* =========================================================
   EBAY
========================================================= */

let ebayToken = null;
let ebayTokenExpires = 0;

async function getEbayToken() {
  if (
    ebayToken &&
    Date.now() < ebayTokenExpires
  ) {
    return ebayToken;
  }

  const clientId =
    process.env.EBAY_CLIENT_ID;

  const clientSecret =
    process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "EBAY_CLIENT_ID / EBAY_CLIENT_SECRET manquants"
    );
  }

  const environment =
    String(
      process.env.EBAY_ENVIRONMENT || "production"
    ).toLowerCase();

  const tokenUrl =
    environment === "sandbox"
      ? "https://api.sandbox.ebay.com/identity/v1/oauth2/token"
      : "https://api.ebay.com/identity/v1/oauth2/token";

  const credentials = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization:
        `Basic ${credentials}`,
      "Content-Type":
        "application/x-www-form-urlencoded"
    },
    body:
      "grant_type=client_credentials" +
      "&scope=" +
      encodeURIComponent(
        "https://api.ebay.com/oauth/api_scope"
      )
  });

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(
      data.error_description ||
      "Impossible d'obtenir le token eBay"
    );
  }

  ebayToken = data.access_token;

  ebayTokenExpires =
    Date.now() +
    ((Number(data.expires_in) || 7200) - 120) *
      1000;

  return ebayToken;
}

function ebayBase() {
  return String(
    process.env.EBAY_ENVIRONMENT ||
      "production"
  ).toLowerCase() === "sandbox"
    ? "https://api.sandbox.ebay.com"
    : "https://api.ebay.com";
}

/* =========================================================
   EBAY CATALOG HOME
========================================================= */

app.get("/api/catalog/home", async (req, res) => {
  try {
    const token = await getEbayToken();

    const limit = Math.min(
      Number(req.query.limit) || 48,
      100
    );

    const country =
      String(req.query.country || "US")
        .toUpperCase();

    const url =
      ebayBase() +
      "/buy/browse/v1/item_summary/search?" +
      new URLSearchParams({
        q: "popular products",
        limit: String(limit),
        filter:
          "buyingOptions:{FIXED_PRICE}",
        fieldgroups: "EXTENDED",
        sort: "BEST_MATCH"
      }).toString();

    const response = await fetch(url, {
      headers: {
        Authorization:
          `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID":
          country === "GB"
            ? "EBAY_GB"
            : country === "FR"
            ? "EBAY_FR"
            : country === "DE"
            ? "EBAY_DE"
            : "EBAY_US"
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json({
      total: data.total || 0,
      items: normalizeEbayItems(
        data.itemSummaries || []
      )
    });
  } catch (e) {
    console.error("eBay home:", e.message);

    res.status(500).json({
      error: "Catalogue eBay indisponible"
    });
  }
});

/* =========================================================
   EBAY SEARCH
========================================================= */

app.get("/api/catalog/search", async (req, res) => {
  try {
    const q = String(
      req.query.q || "popular products"
    ).trim();

    const limit = Math.min(
      Number(req.query.limit) || 48,
      100
    );

    const token = await getEbayToken();

    const url =
      ebayBase() +
      "/buy/browse/v1/item_summary/search?" +
      new URLSearchParams({
        q,
        limit: String(limit),
        filter:
          "buyingOptions:{FIXED_PRICE}",
        fieldgroups: "EXTENDED"
      }).toString();

    const response = await fetch(url, {
      headers: {
        Authorization:
          `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID":
          String(req.query.country || "US")
            .toUpperCase() === "GB"
            ? "EBAY_GB"
            : "EBAY_US"
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json({
      total: data.total || 0,
      items: normalizeEbayItems(
        data.itemSummaries || []
      )
    });
  } catch (e) {
    console.error("eBay search:", e.message);

    res.status(500).json({
      error: "Recherche eBay indisponible"
    });
  }
});

/* =========================================================
   EBAY ITEM DETAIL
========================================================= */

app.get("/api/catalog/item", async (req, res) => {
  try {
    const itemId = String(
      req.query.itemId || ""
    ).trim();

    if (!itemId) {
      return res.status(400).json({
        error: "itemId manquant"
      });
    }

    const token = await getEbayToken();

    const url =
      ebayBase() +
      "/buy/browse/v1/item/" +
      encodeURIComponent(itemId);

    const response = await fetch(url, {
      headers: {
        Authorization:
          `Bearer ${token}`
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json({
      id: data.itemId,
      rating:
        Number(
          data.reviews?.averageRating ||
          data.rating ||
          0
        ),
      sold:
        Number(
          data.quantitySold ||
          data.sold ||
          0
        ),
      title: data.title || "",
      image:
        data.image?.imageUrl || "",
      itemUrl:
        data.itemWebUrl || ""
    });
  } catch (e) {
    console.error("eBay item:", e.message);

    res.status(500).json({
      error: "Produit indisponible"
    });
  }
});

function normalizeEbayItems(items) {
  return items.map((x) => {
    const price =
      Number(x.price?.value) || 0;

    return {
      id: x.itemId,
      itemId: x.itemId,
      name: x.title || "Produit MERCADO",
      title: x.title || "Produit MERCADO",
      category:
        x.categories?.[0]?.categoryName ||
        "General",
      cat:
        x.categories?.[0]?.categoryName ||
        "General",
      price,
      rating:
        Number(
          x.reviews?.averageRating ||
          x.rating ||
          0
        ),
      sold:
        Number(x.quantitySold || 0),
      image:
        x.image?.imageUrl ||
        x.thumbnailImages?.[0]?.imageUrl ||
        "",
      imageUrl:
        x.image?.imageUrl ||
        "",
      thumbnail:
        x.thumbnailImages?.[0]?.imageUrl ||
        "",
      description:
        x.shortDescription ||
        "",
      desc:
        x.shortDescription ||
        "",
      itemUrl:
        x.itemWebUrl ||
        "",
      url:
        x.itemWebUrl ||
        "",
      shipping:
        x.shippingOptions?.[0]?.shippingCost
          ?.value
          ? `${x.shippingOptions[0].shippingCost.value} ${x.shippingOptions[0].shippingCost.currency}`
          : ""
    };
  });
}

/* =========================================================
   REVIEWS
========================================================= */

app.get("/api/reviews", (req, res) => {
  const productId = String(
    req.query.productId || ""
  );

  const result = reviews.filter(
    (r) =>
      String(r.productId) === productId
  );

  res.json({
    reviews: result
  });
});

app.post("/api/reviews", (req, res) => {
  const productId = String(
    req.body.productId || ""
  );

  const text = String(
    req.body.text || ""
  ).trim();

  const stars = Number(req.body.stars);

  if (
    !productId ||
    !text ||
    !Number.isInteger(stars) ||
    stars < 1 ||
    stars > 5
  ) {
    return res.status(400).json({
      error: "Avis invalide"
    });
  }

  const review = {
    id: crypto.randomUUID(),
    productId,
    name:
      String(req.body.name || "Client")
        .slice(0, 80),
    initial:
      String(req.body.initial || "C")
        .slice(0, 1),
    stars,
    date:
      req.body.date ||
      new Date().toLocaleDateString("fr-FR"),
    text: text.slice(0, 2000),
    variant:
      String(req.body.variant || "")
        .slice(0, 200)
  };

  reviews.push(review);

  writeJSON("reviews.json", reviews);

  res.json({
    ok: true,
    review
  });
});

/* =========================================================
   ORDERS
========================================================= */

app.post("/api/order", async (req, res) => {
  try {
    const body = req.body || {};

    const orderId =
      String(
        body.orderId ||
        `MRC-${Date.now()}`
      );

    const order = {
      id: crypto.randomUUID(),
      orderId,
      status: "pending",
      paymentStatus: "pending",
      paymentMethod:
        body.paymentMethod || "GatePay.to",
      total: Number(body.total || 0),
      items:
        Array.isArray(body.items)
          ? body.items
          : [],
      customer:
        body.customer || {},
      createdAt:
        new Date().toISOString()
    };

    orders.push(order);

    writeJSON("orders.json", orders);

    await notifyTelegram(
      formatOrderMessage(order)
    );

    if (order.customer?.email) {
      await sendEmail({
        to: order.customer.email,
        subject:
          `Commande MERCADO ${order.orderId}`,
        text:
          `Votre commande ${order.orderId} a été reçue. ` +
          `Montant : €${order.total.toFixed(2)}.`,
        html: `
          <h2>MERCADO</h2>
          <p>Votre commande <b>${escapeHtml(
            order.orderId
          )}</b> a été reçue.</p>
          <p>Total :
          <b>€${order.total.toFixed(2)}</b></p>
          <p>Paiement : GatePay.to</p>
        `
      });
    }

    res.json({
      ok: true,
      orderId: order.orderId
    });
  } catch (e) {
    console.error("order:", e);

    res.status(500).json({
      error: "Impossible d'enregistrer la commande"
    });
  }
});

/* =========================================================
   GATEPAY.TO
========================================================= */

async function createGatePayPayment(req, res) {
  try {
    if (!GATEPAY_WALLET) {
      return res.status(500).json({
        error:
          "GATEPAY_WALLET_ADDRESS n'est pas configuré sur Render"
      });
    }

    const amount =
      Number(req.body.amount) ||
      Number(req.body.total);

    if (!amount || amount <= 0) {
      return res.status(400).json({
        error: "Montant invalide"
      });
    }

    const orderId =
      String(
        req.body.orderId ||
        req.body.order_id ||
        `MRC-${Date.now()}`
      );

    const payload = {
      wallet: GATEPAY_WALLET,
      amount,
      currency: GATEPAY_CURRENCY,
      callback_url:
        `${PUBLIC_BASE_URL}/api/payment/gatepay/callback`,
      order_id: orderId
    };

    console.log(
      "GatePay request:",
      {
        orderId,
        amount,
        currency: GATEPAY_CURRENCY
      }
    );

    const response = await fetch(
      GATEPAY_API,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
          Accept:
            "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const raw = await response.text();

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      data = {
        raw
      };
    }

    if (!response.ok) {
      console.error(
        "GatePay HTTP error:",
        response.status,
        data
      );

      return res.status(502).json({
        error:
          "GatePay.to a refusé la création du paiement",
        details:
          typeof data === "string"
            ? data
            : data?.error ||
              data?.message ||
              null
      });
    }

    const paymentUrl =
      data.payment_url ||
      data.checkout_url ||
      data.url ||
      data.checkout ||
      data.payment?.url ||
      data.data?.payment_url ||
      data.data?.checkout_url ||
      data.data?.url;

    if (!paymentUrl) {
      console.error(
        "GatePay response sans URL:",
        data
      );

      return res.status(502).json({
        error:
          "GatePay.to n'a pas retourné de lien de paiement",
        response: data
      });
    }

    res.json({
      ok: true,
      order_id: orderId,
      payment_url: paymentUrl,
      checkout_url: paymentUrl
    });
  } catch (e) {
    console.error(
      "GatePay create:",
      e
    );

    res.status(500).json({
      error:
        "GatePay.to est temporairement indisponible"
    });
  }
}

/*
  Nouveau chemin principal.
*/
app.post(
  "/api/payment/gatepay",
  createGatePayPayment
);

/*
  Alias de compatibilité avec certaines versions
  précédentes de ton index.html.
*/
app.post(
  "/api/payment/paygate",
  createGatePayPayment
);

/* =========================================================
   GATEPAY CALLBACK
========================================================= */

app.all(
  "/api/payment/gatepay/callback",
  async (req, res) => {
    try {
      const body = {
        ...(req.query || {}),
        ...(req.body || {})
      };

      const orderId =
        body.order_id ||
        body.orderId ||
        body.merchant_order_id ||
        body.reference ||
        body.invoice_id ||
        body.payment_id ||
        body.order;

      const status = String(
        body.status ||
        body.payment_status ||
        body.state ||
        ""
      ).toLowerCase();

      console.log(
        "GatePay callback:",
        body
      );

      const paidStatuses = [
        "paid",
        "completed",
        "complete",
        "success",
        "successful",
        "confirmed",
        "confirmed_payment"
      ];

      const failedStatuses = [
        "failed",
        "failure",
        "cancelled",
        "canceled",
        "expired",
        "declined"
      ];

      const order =
        orders.find(
          (o) =>
            String(o.orderId) ===
            String(orderId)
        );

      if (order) {
        order.gatepayCallback = body;
        order.updatedAt =
          new Date().toISOString();

        if (
          paidStatuses.includes(status)
        ) {
          const wasPaid =
            order.paymentStatus === "paid";

          order.paymentStatus = "paid";
          order.status = "paid";

          if (!wasPaid) {
            await notifyTelegram(
              "✅ PAIEMENT GATEPAY CONFIRMÉ\n\n" +
              formatOrderMessage(order)
            );
          }
        }

        if (
          failedStatuses.includes(status)
        ) {
          order.paymentStatus = "failed";
          order.status = "payment_failed";
        }

        writeJSON("orders.json", orders);
      }

      /*
        GatePay doit recevoir une réponse HTTP 200.
      */
      res.status(200).json({
        ok: true,
        received: true
      });
    } catch (e) {
      console.error(
        "GatePay callback:",
        e
      );

      res.status(200).json({
        ok: false,
        received: true
      });
    }
  }
);

/* =========================================================
   NOTIFICATIONS DISPONIBILITÉ
========================================================= */

app.post(
  "/api/notify/subscribe",
  (req, res) => {
    const email = String(
      req.body.email || ""
    )
      .trim()
      .toLowerCase();

    const query = String(
      req.body.query || ""
    ).trim();

    if (!email || !email.includes("@")) {
      return res.status(400).json({
        error: "Email invalide"
      });
    }

    subscribers.push({
      id: crypto.randomUUID(),
      email,
      query,
      createdAt:
        new Date().toISOString()
    });

    if (subscribers.length > 1000) {
      subscribers.splice(
        0,
        subscribers.length - 1000
      );
    }

    writeJSON(
      "subscribers.json",
      subscribers
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   PRODUCT VIEWS
========================================================= */

app.post(
  "/api/track-view",
  (req, res) => {
    const email = String(
      req.body.email || ""
    )
      .trim()
      .toLowerCase();

    const product =
      req.body.product || {};

    if (
      !email ||
      !email.includes("@") ||
      !product.id
    ) {
      return res.status(400).json({
        error: "Données invalides"
      });
    }

    productViews.push({
      id: crypto.randomUUID(),
      email,
      product,
      viewedAt:
        new Date().toISOString(),
      reminded: false
    });

    if (productViews.length > 500) {
      productViews.splice(
        0,
        productViews.length - 500
      );
    }

    writeJSON(
      "product-views.json",
      productViews
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   AI
========================================================= */

app.post("/api/ai", async (req, res) => {
  const apiKey =
    process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error: "AI backend non configuré"
    });
  }

  try {
    const question =
      String(req.body.question || "")
        .trim();

    const history =
      Array.isArray(req.body.history)
        ? req.body.history.slice(-10)
        : [];

    const product =
      req.body.product || null;

    const system =
      `Tu es MERCADO AI, assistant du site e-commerce MERCADO.
Réponds clairement et utilement.
Ne prétends jamais connaître une information qui n'est pas fournie.
Pour les produits, utilise les données fournies.
Le paiement disponible sur MERCADO est GatePay.to.`;

    const messages = [
      {
        role: "system",
        content: system
      },
      ...history,
      {
        role: "user",
        content:
          `Produit actuel:\n${JSON.stringify(
            product
          )}\n\nQuestion:\n${question}`
      }
    ];

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${apiKey}`,
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          model:
            process.env.OPENAI_MODEL ||
            "gpt-4o-mini",
          messages,
          temperature: 0.4,
          max_tokens: 800
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(502).json({
        error: "AI indisponible"
      });
    }

    const answer =
      data.choices?.[0]?.message?.content ||
      "Je n'ai pas pu répondre.";

    res.json({
      answer
    });
  } catch (e) {
    console.error("AI:", e);

    res.status(500).json({
      error: "Erreur AI"
    });
  }
});

/* =========================================================
   AI LOG
========================================================= */

app.post("/api/ai-log", (req, res) => {
  /*
    Journalisation minimale.
    On ne bloque jamais le client.
  */

  res.json({
    ok: true
  });
});

/* =========================================================
   TRANSLATE
========================================================= */

app.post("/api/translate", async (req, res) => {
  const texts = Array.isArray(
    req.body.texts
  )
    ? req.body.texts
    : [];

  const target = String(
    req.body.target || "en"
  );

  if (
    !texts.length ||
    !process.env.OPENAI_API_KEY
  ) {
    return res.json({
      translations: texts
    });
  }

  try {
    const prompt =
      `Translate each text to ${target}.
Return ONLY a JSON array of translated strings.
Texts:
${JSON.stringify(texts)}`;

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          model:
            process.env.OPENAI_MODEL ||
            "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0
        })
      }
    );

    const data = await response.json();

    const content =
      data.choices?.[0]?.message?.content ||
      "";

    let translations;

    try {
      translations =
        JSON.parse(
          content
            .replace(/^```json/i, "")
            .replace(/```$/i, "")
            .trim()
        );
    } catch {
      translations = texts;
    }

    res.json({
      translations
    });
  } catch (e) {
    res.json({
      translations: texts
    });
  }
});

/* =========================================================
   TELEGRAM
========================================================= */

async function notifyTelegram(message) {
  const token =
    process.env.TELEGRAM_BOT_TOKEN;

  const chatId =
    process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return false;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message
        })
      }
    );

    return response.ok;
  } catch (e) {
    console.error(
      "Telegram:",
      e.message
    );

    return false;
  }
}

function formatOrderMessage(order) {
  const lines = [];

  lines.push("🛒 NOUVELLE COMMANDE MERCADO");
  lines.push("");
  lines.push(
    `Order: ${order.orderId}`
  );
  lines.push(
    `Paiement: GatePay.to`
  );
  lines.push(
    `Statut: ${order.paymentStatus}`
  );
  lines.push(
    `Total: €${Number(
      order.total || 0
    ).toFixed(2)}`
  );

  lines.push("");
  lines.push("CLIENT");

  const customer =
    order.customer || {};

  lines.push(
    `Nom: ${customer.name || ""}`
  );

  lines.push(
    `Email: ${customer.email || ""}`
  );

  lines.push(
    `Téléphone: ${customer.phone || ""}`
  );

  lines.push(
    `Adresse: ${customer.address || ""}`
  );

  lines.push("");
  lines.push("PRODUITS");

  for (
    const item of order.items || []
  ) {
    lines.push(
      `• ${item.name || "Produit"} × ${
        item.qty || 1
      } — €${Number(
        item.price || 0
      ).toFixed(2)}`
    );
  }

  return lines.join("\n");
}

/* =========================================================
   ADMIN
========================================================= */

function adminAuthorized(req) {
  const key =
    process.env.ADMIN_KEY;

  if (!key) return false;

  return (
    req.headers["x-admin-key"] === key
  );
}

app.get(
  "/api/admin/orders",
  (req, res) => {
    if (!adminAuthorized(req)) {
      return res.status(401).json({
        error: "Non autorisé"
      });
    }

    res.json({
      orders
    });
  }
);

/* =========================================================
   ADMIN REMINDERS
========================================================= */

app.post(
  "/api/admin/run-reminders",
  async (req, res) => {
    if (!adminAuthorized(req)) {
      return res.status(401).json({
        error: "Non autorisé"
      });
    }

    const delayHours =
      Number(
        process.env.REMINDER_DELAY_HOURS ||
        24
      );

    const limit =
      Date.now() -
      delayHours *
        60 *
        60 *
        1000;

    let sent = 0;

    for (
      const view of productViews
    ) {
      if (
        view.reminded ||
        !view.viewedAt
      ) {
        continue;
      }

      if (
        new Date(view.viewedAt).getTime() >
        limit
      ) {
        continue;
      }

      const product =
        view.product || {};

      const ok =
        await sendEmail({
          to: view.email,
          subject:
            `Toujours intéressé(e) par ${
              product.name || "ce produit"
            } ?`,
          text:
            `Vous avez récemment consulté ${
              product.name || "un produit"
            } sur MERCADO.`,
          html: `
            <h2>MERCADO</h2>
            <p>
              Vous avez récemment consulté
              <b>${escapeHtml(
                product.name || "ce produit"
              )}</b>.
            </p>
            ${
              product.img
                ? `<img src="${escapeHtml(
                    product.img
                  )}" style="max-width:300px">`
                : ""
            }
          `
        });

      if (ok) {
        view.reminded = true;
        sent++;
      }
    }

    writeJSON(
      "product-views.json",
      productViews
    );

    res.json({
      ok: true,
      sent
    });
  }
);

/* =========================================================
   STATIC FRONTEND
========================================================= */

app.use(
  express.static(PUBLIC_DIR, {
    etag: false,
    maxAge: 0,
    setHeaders: (res) => {
      res.setHeader(
        "Cache-Control",
        "no-cache, no-store, must-revalidate"
      );
      res.setHeader(
        "Pragma",
        "no-cache"
      );
      res.setHeader(
        "Expires",
        "0"
      );
    }
  })
);

/* =========================================================
   SPA FALLBACK
========================================================= */

app.get("*", (req, res) => {
  const indexPath =
    path.join(
      PUBLIC_DIR,
      "index.html"
    );

  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send(
      "MERCADO index.html introuvable"
    );
  }
});

/* =========================================================
   HELPERS
========================================================= */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* =========================================================
   START
========================================================= */

app.listen(PORT, () => {
  console.log("");
  console.log("=================================");
  console.log("        MERCADO SERVER");
  console.log("=================================");
  console.log(
    `Port: ${PORT}`
  );
  console.log(
    `GatePay: ${GATEPAY_API}`
  );
  console.log(
    `Wallet configured: ${
      GATEPAY_WALLET ? "YES" : "NO"
    }`
  );
  console.log(
    `Public URL: ${PUBLIC_BASE_URL}`
  );
  console.log(
    `eBay configured: ${
      process.env.EBAY_CLIENT_ID
        ? "YES"
        : "NO"
    }`
  );
  console.log("=================================");
});
