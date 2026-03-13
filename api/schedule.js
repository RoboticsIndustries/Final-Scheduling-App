const BIN_ID  = "69b361f5c3097a1dd51e8c8b";
const API_KEY = "$2a$10$sw7DsOPVqOXjcl1OYlh3Te3ogd1vDTGKkJQNm9E0qb3r9G6uMSGJS";
const BIN_URL = `https://api.jsonbin.io/v3/b/${BIN_ID}`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    try {
      const r = await fetch(BIN_URL + "/latest", {
        headers: { "X-Master-Key": API_KEY }
      });
      const data = await r.json();
      return res.status(200).json(data.record);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "PUT") {
    try {
      const r = await fetch(BIN_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Master-Key": API_KEY },
        body: JSON.stringify(req.body)
      });
      const data = await r.json();
      return res.status(200).json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}