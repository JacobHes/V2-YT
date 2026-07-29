// ============================================================
// GET /api/idoklad-invoices
// Fetches your issued invoices from iDoklad and returns a trimmed
// JSON list. The iDoklad OAuth client_id/client_secret are read from
// server-side env vars and NEVER exposed to the browser.
//
//   IDOKLAD_CLIENT_ID       your iDoklad API client id
//   IDOKLAD_CLIENT_SECRET   your iDoklad API client secret  (secret!)
//
// Auth: OAuth2 client_credentials against identity.idoklad.cz,
// then GET https://api.idoklad.cz/v3/IssuedInvoices.
// Add ?debug=1 to get the raw first invoice back for field mapping.
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const id = process.env.IDOKLAD_CLIENT_ID;
  const secret = process.env.IDOKLAD_CLIENT_SECRET;
  if (!id || !secret) {
    return res.status(200).json({ ok: false, error: 'not_configured',
      message: 'iDoklad credentials are not set on the server yet.' });
  }

  try {
    // 1) OAuth token (client_credentials)
    const tokenRes = await fetch('https://identity.idoklad.cz/server/connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: id,
        client_secret: secret,
        scope: 'idoklad_api'
      })
    });
    if (!tokenRes.ok) {
      const detail = (await tokenRes.text()).slice(0, 400);
      return res.status(200).json({ ok: false, error: 'auth_failed', status: tokenRes.status, detail });
    }
    const token = (await tokenRes.json()).access_token;
    if (!token) return res.status(200).json({ ok: false, error: 'no_token' });

    // 2) Issued invoices — try newest-first, fall back to unsorted.
    const base = 'https://api.idoklad.cz/v3/IssuedInvoices';
    const authHeaders = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
    let invRes = await fetch(base + '?pagesize=25&sort=DateOfIssue~desc', { headers: authHeaders });
    if (!invRes.ok) invRes = await fetch(base, { headers: authHeaders });
    if (!invRes.ok) {
      const detail = (await invRes.text()).slice(0, 400);
      return res.status(200).json({ ok: false, error: 'fetch_failed', status: invRes.status, detail });
    }
    const data = await invRes.json();
    let list = [];
    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.Data)) list = data.Data;
    else if (data && Array.isArray(data.data)) list = data.data;
    else if (data && Array.isArray(data.Items)) list = data.Items;
    else if (data && data.Data && Array.isArray(data.Data.Items)) list = data.Data.Items;

    if (req.query && req.query.debug) {
      return res.status(200).json({
        ok: true, debug: true,
        topType: Array.isArray(data) ? 'array' : typeof data,
        topKeys: (data && typeof data === 'object' && !Array.isArray(data)) ? Object.keys(data) : null,
        listLen: list.length,
        sample: list[0] || null,
        rawSnippet: JSON.stringify(data).slice(0, 1000)
      });
    }

    const invoices = list.map(iv => {
      const prices = iv.Prices || {};
      return {
        id: iv.Id,
        number: iv.DocumentNumber || iv.Number || null,
        partner: iv.PartnerName || iv.PartnerContactName || iv.CompanyName || null,
        partnerId: iv.PartnerId != null ? iv.PartnerId : null,
        issued: iv.DateOfIssue || null,
        due: iv.DateOfMaturity || null,
        paidOn: iv.DateOfPayment || null,
        // TotalWithVat is in the invoice currency; Hc = home currency (CZK)
        total: prices.TotalWithVat != null ? prices.TotalWithVat
             : (prices.TotalWithVatHc != null ? prices.TotalWithVatHc
             : (iv.TotalWithVat != null ? iv.TotalWithVat : null)),
        totalHc: prices.TotalWithVatHc != null ? prices.TotalWithVatHc : null,
        currencyId: iv.CurrencyId != null ? iv.CurrencyId : null,
        // PaymentStatus: 0 unpaid, 1 paid, 2 partially, 3 overpaid (iDoklad v3)
        paymentStatus: iv.PaymentStatus != null ? iv.PaymentStatus : null
      };
    });
    // Newest first, regardless of what the API returned.
    invoices.sort((a, b) => String(b.issued || '').localeCompare(String(a.issued || '')));

    return res.status(200).json({ ok: true, count: invoices.length, invoices });
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'exception', message: String(e && e.message || e).slice(0, 300) });
  }
}
