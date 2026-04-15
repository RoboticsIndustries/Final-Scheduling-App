import { useState, useEffect, useCallback, useRef } from "react";

// ─── API ──────────────────────────────────────────────────────────────────────
const BIN_ID  = "69c713c1aa77b81da92916cd";
const API_KEY = "$2a$10$sw7DsOPVqOXjcl1OYlh3Te3ogd1vDTGKkJQNm9E0qb3r9G6uMSGJS";
const BIN_URL = `https://api.jsonbin.io/v3/b/${BIN_ID}`;

async function loadBin() {
  const r = await fetch(BIN_URL + "/latest", {
    headers: { "X-Master-Key": API_KEY, "X-Bin-Meta": "false" }
  });
  if (!r.ok) throw new Error("load failed");
  return r.json();
}
async function saveBin(data) {
  const r = await fetch(BIN_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Master-Key": API_KEY },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error("save failed");
  return r.json();
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const ALL_SLOTS     = ["8-9","9-10","10-11","11-12","12-1","1-2","2-3","3-4","4-5","5-6","6-7"];
const SCOUTS_PER_SLOT  = 6;
const MAX_SCOUT_IN_ROW = 2;
const MAX_SCOUT_PER_DAY = 7;

// Fixed role positions — these people appear in the header block only
const FIXED_POSITIONS = new Set(["Drive Team","Pit Captain","Scouting Lead","Lead Programmer"]);

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function normalizeSlot(raw) {
  return raw.trim().replace(/\s*(AM|PM)/gi, "").trim();
}

function classifyRole(roleRaw) {
  const r = (roleRaw || "").trim().toLowerCase();
  if (r.includes("drive"))          return "Drive Team";
  if (r.includes("pit captain"))    return "Pit Captain";
  if (r.includes("scouting lead"))  return "Scouting Lead";
  if (r.includes("lead"))           return "Lead Programmer";
  return "Member";
}

// ─── CSV DETECTOR ─────────────────────────────────────────────────────────────
// Automatically detects whether CSV is old format (Sat/Sun) or new format (Thu/Fri/Sat)
// by inspecting the header row
function detectFormat(headerRow) {
  const h = headerRow.join(" ").toLowerCase();
  if (h.includes("thurs") || h.includes("thu")) return "new"; // Thu/Fri/Sat format
  return "old"; // Sat/Sun format
}

// ─── CSV PARSER ───────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const cols = []; let cur = "", inQ = false;
  for (const ch of line) {
    if      (ch === '"')         { inQ = !inQ; }
    else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ""; }
    else                         { cur += ch; }
  }
  cols.push(cur.trim());
  return cols;
}

function parseCSV(text) {
  const rawLines = text.trim().split("\n").map(parseCSVLine);
  if (rawLines.length < 2) return { members: [], fixedRoles: {}, days: [] };

  const header = rawLines[0];
  const format = detectFormat(header);
  const dataLines = rawLines.slice(1);
  const membersMap = {};

  for (const line of dataLines) {
    if (!line || line.length < 5) continue;
    const firstName = (line[1] || "").trim();
    const lastName  = (line[2] || "").trim();
    // Normalize name: proper case to catch duplicates like "Sunny kota" vs "Sunny Kota"
    const rawName = `${firstName} ${lastName}`.trim();
    const name = rawName.replace(/\b\w/g, c => c.toUpperCase());
    if (!name) continue;
    const nl = name.toLowerCase();
    if (nl.includes("filler") || nl.match(/^first\s*\d*\s*last\s*\d*$/i)) continue;

    let timingsByDay = {};
    let roleCol, progCol, mechCol;

    if (format === "new") {
      // New format: col4=Wed, col5=Thu allday, col6=Thu hours,
      //             col7=Fri allday, col8=Fri hours, col9=Sat allday, col10=Sat hours
      //             col12=role, col13=pitProg, col14=pitMech
      roleCol = 12; progCol = 13; mechCol = 14;

      const thuAll = (line[5] || "").trim().toLowerCase();
      const thuRaw = (line[6] || "").trim();
      const friAll = (line[7] || "").trim().toLowerCase();
      const friRaw = (line[8] || "").trim();
      const satAll = (line[9] || "").trim().toLowerCase();
      const satRaw = (line[10] || "").trim();

      const thuSlots = thuAll === "yes" ? [...ALL_SLOTS]
        : thuRaw ? thuRaw.split(",").map(normalizeSlot).filter(s => ALL_SLOTS.includes(s)) : [];
      const friSlots = friAll === "yes" ? [...ALL_SLOTS]
        : friRaw ? friRaw.split(",").map(normalizeSlot).filter(s => ALL_SLOTS.includes(s)) : [];
      const satSlots = satAll === "yes" ? [...ALL_SLOTS]
        : satRaw ? satRaw.split(",").map(normalizeSlot).filter(s => ALL_SLOTS.includes(s)) : [];

      if (thuSlots.length) timingsByDay["Thursday"] = thuSlots;
      if (friSlots.length) timingsByDay["Friday"]   = friSlots;
      if (satSlots.length) timingsByDay["Saturday"] = satSlots;

    } else {
      // Old format: col4=Fri arrival, col5=Sat allday, col6=Sat hours,
      //             col7=Sun allday, col8=Sun hours
      //             col10=role, col12=pitProg, col13=pitMech
      roleCol = 10; progCol = 12; mechCol = 13;

      const friArrival = (line[4] || "").trim().toLowerCase();
      const satAll     = (line[5] || "").trim().toLowerCase();
      const satRaw     = (line[6] || "").trim();
      const sunAll     = (line[7] || "").trim().toLowerCase();
      const sunRaw     = (line[8] || "").trim();

      let friSlots = [];
      if      (friArrival.includes("4 pm") || friArrival.includes("4pm")) friSlots = ["4-5","5-6"];
      else if (friArrival.includes("5 pm") || friArrival.includes("5pm")) friSlots = ["5-6"];
      else if (friArrival.startsWith("yes"))                               friSlots = ["4-5","5-6"];

      const satSlots = satAll === "yes" ? [...ALL_SLOTS]
        : satRaw ? satRaw.split(",").map(normalizeSlot).filter(s => ALL_SLOTS.includes(s)) : [];
      const sunSlots = sunAll === "yes" ? [...ALL_SLOTS]
        : sunRaw ? sunRaw.split(",").map(normalizeSlot).filter(s => ALL_SLOTS.includes(s)) : [];

      if (friSlots.length) timingsByDay["Friday"]   = friSlots;
      if (satSlots.length) timingsByDay["Saturday"] = satSlots;
      if (sunSlots.length) timingsByDay["Sunday"]   = sunSlots;
    }

    const roleRaw     = (line[roleCol] || "").trim();
    const pitProgCert = (line[progCol] || "").trim().toLowerCase();
    const pitMechCert = (line[mechCol] || "").trim().toLowerCase();
    const position    = classifyRole(roleRaw);
    const hasPitProg  = pitProgCert === "yes";
    const hasPitMech  = pitMechCert === "yes";

    if (membersMap[name]) {
      // Merge duplicate entries — keep any cert that was ever "yes"
      membersMap[name].hasPitProg = membersMap[name].hasPitProg || hasPitProg;
      membersMap[name].hasPitMech = membersMap[name].hasPitMech || hasPitMech;
      for (const [day, slots] of Object.entries(timingsByDay)) {
        if (!membersMap[name].timingsByDay[day]) membersMap[name].timingsByDay[day] = [];
        for (const s of slots) {
          if (!membersMap[name].timingsByDay[day].includes(s))
            membersMap[name].timingsByDay[day].push(s);
        }
      }
    } else {
      membersMap[name] = { position, hasPitProg, hasPitMech, timingsByDay };
    }
  }

  // Separate fixed roles from schedulable members
  const fixedRoles = { driveTeam: [], pitCaptain: [], leadProgrammer: [], scoutingLead: [] };
  const members = [];

  for (const [name, info] of Object.entries(membersMap)) {
    if (FIXED_POSITIONS.has(info.position)) {
      // Fixed role — goes in header block only
      switch (info.position) {
        case "Drive Team":      fixedRoles.driveTeam.push(name);      break;
        case "Pit Captain":     fixedRoles.pitCaptain.push(name);     break;
        case "Scouting Lead":   fixedRoles.scoutingLead.push(name);   break;
        case "Lead Programmer": fixedRoles.leadProgrammer.push(name); break;
        default: break;
      }
    } else {
      // Regular member — gets scheduled per slot
      members.push({
        name,
        hasPitProg: info.hasPitProg,
        hasPitMech: info.hasPitMech,
        timingsByDay: info.timingsByDay,
      });
    }
  }

  const dayOrder = ["Thursday","Friday","Saturday","Sunday"];
  const days = dayOrder.filter(d => members.some(m => (m.timingsByDay[d] || []).length > 0));
  return { members, fixedRoles, days };
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
function generateSchedule(members, days) {
  const schedule = {};
  const byName = Object.fromEntries(members.map(m => [m.name, m]));

  // Build pit prog and mech queues from certified members only
  // Queues persist across all days for continuous fair rotation
  const progQueue = members.filter(m => m.hasPitProg).map(m => m.name);
  const mechQueue = members.filter(m => m.hasPitMech && !m.hasPitProg).map(m => m.name);
  // People with both certs go in prog queue only to avoid double-counting
  const bothCert  = members.filter(m => m.hasPitProg && m.hasPitMech).map(m => m.name);
  // Remove dual-cert from mech queue (they're in prog queue)
  const mechOnly  = mechQueue.filter(n => !bothCert.includes(n));

  const recorderQueue = members.map(m => m.name);

  for (const day of days) {
    schedule[day] = {};

    // Reset per-day state
    const state = {};
    for (const m of members) {
      state[m.name] = { scoutCount: 0, scoutInARow: 0, lastRecorder: -99 };
    }

    const daySlots   = ALL_SLOTS;
    const dayMembers = members.filter(m => (m.timingsByDay[day] || []).length > 0);

    for (let i = 0; i < daySlots.length; i++) {
      const slot   = daySlots[i];
      const here   = (name) => (byName[name]?.timingsByDay[day] || []).includes(slot);
      const used   = new Set();

      // ── Pit Programmer (1 per slot, round-robin from certified) ──
      let prog = null;
      for (let j = 0; j < progQueue.length; j++) {
        const name = progQueue[j];
        if (here(name) && !used.has(name)) {
          prog = name;
          // Rotate to back
          progQueue.splice(j, 1);
          progQueue.push(name);
          break;
        }
      }
      if (prog) used.add(prog);

      // ── Pit Mechanic (1 per slot, round-robin from mech-only certified) ──
      let mech = null;
      for (let j = 0; j < mechOnly.length; j++) {
        const name = mechOnly[j];
        if (here(name) && !used.has(name)) {
          mech = name;
          mechOnly.splice(j, 1);
          mechOnly.push(name);
          break;
        }
      }
      if (mech) used.add(mech);

      // ── Scouting: always fill 6 per slot ──
      // Priority: rested people first, then anyone under daily max, then anyone at all
      const here_free = dayMembers.filter(m => here(m.name) && !used.has(m.name));
      const rested = here_free
        .filter(m => state[m.name].scoutInARow < MAX_SCOUT_IN_ROW && state[m.name].scoutCount < MAX_SCOUT_PER_DAY)
        .sort((a,b) => state[a.name].scoutCount - state[b.name].scoutCount);
      const under_max = here_free
        .filter(m => state[m.name].scoutCount < MAX_SCOUT_PER_DAY && !rested.find(r => r.name === m.name))
        .sort((a,b) => state[a.name].scoutCount - state[b.name].scoutCount);
      const last_resort = here_free.filter(m =>
        !rested.find(r => r.name === m.name) && !under_max.find(r => r.name === m.name)
      );
      const scoutPool = [...rested, ...under_max, ...last_resort];
      const scouting = [];
      for (const m of scoutPool) {
        if (scouting.length >= SCOUTS_PER_SLOT) break;
        scouting.push(m.name); used.add(m.name);
        state[m.name].scoutCount++; state[m.name].scoutInARow++;
      }
      for (const m of dayMembers) {
        if (!scouting.includes(m.name)) state[m.name].scoutInARow = 0;
      }

      // ── Recorder (1 from remaining off, min 2-slot gap) ──
      const offPool = dayMembers.filter(m => here(m.name) && !used.has(m.name)).map(m => m.name);
      let recorder = null;
      for (let j = 0; j < recorderQueue.length; j++) {
        const name = recorderQueue[j];
        if (offPool.includes(name) && (i - state[name].lastRecorder) > 2) {
          recorder = name;
          recorderQueue.splice(j, 1);
          recorderQueue.push(name);
          break;
        }
      }
      if (recorder) {
        used.add(recorder);
        state[recorder].lastRecorder = i;
      }

      // ── Off ──
      const off = dayMembers.filter(m => here(m.name) && !used.has(m.name)).map(m => m.name);

      schedule[day][slot] = {
        pitProg:  prog     ? [prog]     : [],
        pitMech:  mech     ? [mech]     : [],
        scouting,
        recorder: recorder ? [recorder] : [],
        off,
      };
    }
  }
  return schedule;
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────
function parseSlotTime(day, slot, dayDates) {
  const dateStr = dayDates[day]; if (!dateStr) return null;
  const base = new Date(dateStr + "T00:00:00");
  if (isNaN(base)) return null;
  const h = parseInt(slot.split("-")[0]);
  base.setHours((h >= 1 && h <= 7) ? h + 12 : h, 0, 0, 0);
  return base;
}

async function requestNotifPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

// ─── COLORS ───────────────────────────────────────────────────────────────────
const ACCENT = {
  "Pit Programmer": "#f4a261",
  "Pit Mechanic":   "#ff6b35",
  "Scouting":       "#56cfe1",
  "Recorder":       "#a78bfa",
  "Off":            "#888",
};

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView]               = useState("loading");
  const [csvText, setCsvText]         = useState("");
  const [csvLoaded, setCsvLoaded]     = useState(false);
  const [schedule, setSchedule]       = useState(null);
  const [fixedRoles, setFixedRoles]   = useState(null);
  const [days, setDays]               = useState([]);
  const [selectedDay, setSelectedDay] = useState(null);
  const [dayDates, setDayDates]       = useState({});
  const [userName, setUserName]       = useState(() => localStorage.getItem("frc_user") || "");
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [parseError, setParseError]   = useState("");
  const [syncStatus, setSyncStatus]   = useState("idle");
  const [jsonPaste, setJsonPaste]     = useState("");
  const [jsonError, setJsonError]     = useState("");
  const notifTimers = useRef([]);

  // Load on mount
  useEffect(() => {
    loadBin()
      .then(rec => {
        if (rec && rec.schedule) {
          if (rec.fixedRoles) setFixedRoles(rec.fixedRoles);
          if (rec.dayDates)   setDayDates(p => ({ ...p, ...rec.dayDates }));
          if (rec.days?.length) { setDays(rec.days); setSelectedDay(rec.days[0]); }
          setSchedule(rec.schedule);
          setView("full");
        } else setView("landing");
      })
      .catch(() => setView("landing"));
  }, []);

  const handleCSVUpload = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { setCsvText(ev.target.result); setCsvLoaded(true); setParseError(""); };
    reader.readAsText(file);
  };

  const handleGenerate = async () => {
    if (!csvText) return;
    try {
      setSyncStatus("saving");
      const { members, fixedRoles: fr, days: d } = parseCSV(csvText);
      if (!members.length) { setParseError("No schedulable members found. Check your CSV."); setSyncStatus("idle"); return; }
      const sched = generateSchedule(members, d);
      const dates = {};
      for (const day of d) dates[day] = "";
      await saveBin({ schedule: sched, fixedRoles: fr, days: d, dayDates: dates });
      setSchedule(sched); setFixedRoles(fr); setDays(d); setSelectedDay(d[0]);
      setDayDates(dates);
      setSyncStatus("saved"); setParseError(""); setView("full");
      setTimeout(() => setSyncStatus("idle"), 3000);
    } catch(e) { setSyncStatus("error"); setParseError("Error: " + e.message); }
  };

  const handlePasteJSON = async () => {
    if (!jsonPaste.trim()) return;
    try {
      setSyncStatus("saving");
      const data = JSON.parse(jsonPaste.trim());
      if (!data.schedule) { setJsonError("Invalid JSON — missing 'schedule'."); setSyncStatus("idle"); return; }
      await saveBin(data);
      setSchedule(data.schedule);
      if (data.fixedRoles) setFixedRoles(data.fixedRoles);
      if (data.days?.length) { setDays(data.days); setSelectedDay(data.days[0]); }
      if (data.dayDates) setDayDates(p => ({ ...p, ...data.dayDates }));
      setSyncStatus("saved"); setJsonError(""); setJsonPaste(""); setView("full");
      setTimeout(() => setSyncStatus("idle"), 3000);
    } catch(e) { setJsonError("Invalid JSON: " + e.message); setSyncStatus("idle"); }
  };

  const handleDayDate = async (day, date) => {
    const updated = { ...dayDates, [day]: date };
    setDayDates(updated);
    try { await saveBin({ schedule, fixedRoles, days, dayDates: updated }); } catch(e) {}
  };

  const allNames = schedule
    ? [...new Set(Object.values(schedule).flatMap(ds =>
        Object.values(ds).flatMap(s =>
          [...(s.pitProg||[]), ...(s.pitMech||[]), ...(s.scouting||[]), ...(s.recorder||[]), ...(s.off||[])]
        )
      ))].sort()
    : [];

  const getPersonalSlots = useCallback((name) => {
    if (!schedule || !name) return [];
    const result = [];
    for (const [day, ds] of Object.entries(schedule))
      for (const [slot, r] of Object.entries(ds)) {
        let role = null;
        if      (r.pitProg?.includes(name))   role = "Pit Programmer";
        else if (r.pitMech?.includes(name))   role = "Pit Mechanic";
        else if (r.scouting?.includes(name))  role = "Scouting";
        else if (r.recorder?.includes(name))  role = "Recorder";
        else if (r.off?.includes(name))       role = "Off";
        if (role) result.push({ day, slot, role });
      }
    return result;
  }, [schedule]);

  const setupNotifs = useCallback(async (name) => {
    const granted = await requestNotifPermission();
    if (!granted) { alert("Allow notifications in browser settings."); return; }
    setNotifEnabled(true);
    notifTimers.current.forEach(clearTimeout);
    notifTimers.current = [];
    for (const { day, slot, role } of getPersonalSlots(name)) {
      if (role === "Off") continue;
      const t = parseSlotTime(day, slot, dayDates); if (!t) continue;
      const delay = t.getTime() - 10 * 60 * 1000 - Date.now(); if (delay < 0) continue;
      notifTimers.current.push(setTimeout(() =>
        new Notification("PitSync", { body: `${role} at ${slot} (${day}) — starting soon.` })
      , delay));
    }
  }, [getPersonalSlots, dayDates]);

  const effectiveDays = days.length > 0 ? days
    : schedule ? ["Thursday","Friday","Saturday","Sunday"].filter(d => schedule[d] && Object.keys(schedule[d]).length > 0) : [];
  const effectiveDay = (selectedDay && effectiveDays.includes(selectedDay)) ? selectedDay : (effectiveDays[0] || null);
  const hasSchedule  = !!schedule && effectiveDays.length > 0;

  if (view === "loading") return (
    <div style={{ ...S.root, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:16 }}>
      <div style={S.spinner} />
      <p style={{ color:"#555", fontSize:13, letterSpacing:2 }}>LOADING...</p>
    </div>
  );

  return (
    <div style={S.root}>
      <div style={S.noise} />
      <header style={S.header}>
        <div style={S.hi}>
          <span style={S.logo}>PITSYNC</span>
          <nav style={S.nav}>
            {[["admin","Admin"], ...(hasSchedule ? [["personal","My Schedule"],["full","Schedule"]] : [])]
              .map(([v, label]) => (
                <button key={v} style={view===v ? {...S.nb,...S.nba} : S.nb} onClick={() => setView(v)}>{label}</button>
              ))}
          </nav>
        </div>
      </header>

      <main style={S.main}>

        {/* LANDING */}
        {view === "landing" && (
          <div style={{ textAlign:"center", paddingTop:80 }}>
            <h1 style={S.ht}>PITSYNC</h1>
            <p style={{ color:"#555", fontSize:13, letterSpacing:3, marginBottom:32 }}>FRC COMPETITION SCHEDULER</p>
            <p style={{ color:"#666", fontSize:13, maxWidth:400, margin:"0 auto 40px", lineHeight:1.8 }}>No schedule yet. Go to Admin to upload the CSV.</p>
            <button style={S.bp} onClick={() => setView("admin")}>Go to Admin</button>
          </div>
        )}

        {/* ADMIN */}
        {view === "admin" && (
          <div style={S.panel}>
            <h2 style={S.pt}>Admin</h2>
            <p style={S.pd}>Upload the Google Form CSV — the schedule generates automatically.</p>

            <div style={S.fg}>
              <label style={S.lbl}>Upload CSV</label>
              <label style={S.fu}>
                Choose file
                <input type="file" accept=".csv" onChange={handleCSVUpload} style={{ display:"none" }} />
              </label>
              {csvLoaded && <span style={S.ok}>Loaded</span>}
            </div>
            {parseError && <div style={S.eb}>{parseError}</div>}
            <button
              style={{ ...S.bp, opacity:csvLoaded?1:0.4, cursor:csvLoaded?"pointer":"not-allowed" }}
              onClick={handleGenerate} disabled={!csvLoaded}>
              {syncStatus==="saving" ? "Saving..." : syncStatus==="saved" ? "Saved!" : "Generate & Save Schedule"}
            </button>

            {hasSchedule && (
              <>
                <div style={S.sb}>Live — all devices update automatically.</div>
                <div style={{ marginTop:24 }}>
                  <p style={{ ...S.lbl, marginBottom:12 }}>Competition Dates (for notifications)</p>
                  {effectiveDays.map(day => (
                    <div key={day} style={{ display:"flex", alignItems:"center", gap:16, marginBottom:12 }}>
                      <span style={{ ...S.lbl, margin:0, minWidth:80, color:"#f4a261" }}>{day}</span>
                      <input type="date" value={dayDates[day]||""} onChange={e => handleDayDate(day, e.target.value)} style={{ ...S.input, flex:1 }} />
                    </div>
                  ))}
                </div>
              </>
            )}

            <div style={{ marginTop:32, borderTopWidth:1, borderTopStyle:"solid", borderTopColor:"#1e1e2e", paddingTop:24 }}>
              <p style={S.lbl}>Or paste schedule JSON directly</p>
              <textarea
                value={jsonPaste}
                onChange={e => setJsonPaste(e.target.value)}
                placeholder="Paste JSON here..."
                style={{ ...S.input, height:100, resize:"vertical", fontFamily:"monospace", fontSize:11 }}
              />
              {jsonError && <div style={{ ...S.eb, marginTop:8 }}>{jsonError}</div>}
              <button
                style={{ ...S.bp, marginTop:10, opacity:jsonPaste.trim()?1:0.4, cursor:jsonPaste.trim()?"pointer":"not-allowed" }}
                onClick={handlePasteJSON} disabled={!jsonPaste.trim()}>
                {syncStatus==="saving" ? "Saving..." : "Load from JSON"}
              </button>
            </div>
          </div>
        )}

        {/* MY SCHEDULE */}
        {view === "personal" && (
          <div style={S.panel}>
            <h2 style={S.pt}>My Schedule</h2>
            {!hasSchedule ? <p style={S.pd}>No schedule yet.</p> : (
              <>
                <div style={S.fg}>
                  <label style={S.lbl}>Your Name</label>
                  <select value={userName}
                    onChange={e => { const n=e.target.value; setUserName(n); localStorage.setItem("frc_user",n); }}
                    style={S.input}>
                    <option value="">Select your name</option>
                    {allNames.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                {userName && (
                  <>
                    <button style={{ ...S.bs, marginBottom:24 }} onClick={() => setupNotifs(userName)}>
                      {notifEnabled ? "Notifications Active" : "Enable Notifications"}
                    </button>
                    {effectiveDays.map(day => {
                      const mySlots = getPersonalSlots(userName).filter(x => x.day === day);
                      return (
                        <div key={day} style={{ marginBottom:28 }}>
                          <div style={S.dh}>{day}</div>
                          {!mySlots.length
                            ? <p style={{ color:"#444", fontSize:13 }}>No assignments.</p>
                            : <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                                {mySlots.map(({ slot, role }) => {
                                  const accent = ACCENT[role] || "#555";
                                  return (
                                    <div key={slot+role} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:accent, borderRadius:6, padding:"12px 16px" }}>
                                      <span style={{ fontSize:16, fontWeight:"bold", color:accent, letterSpacing:1 }}>{slot}</span>
                                      <span style={{ fontSize:12, color:accent, letterSpacing:1, textTransform:"uppercase" }}>{role}</span>
                                    </div>
                                  );
                                })}
                              </div>
                          }
                        </div>
                      );
                    })}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* FULL SCHEDULE */}
        {view === "full" && hasSchedule && (
          <div>
            {fixedRoles && (
              <div style={S.fixedBlock} className="fixed-block">
                <div style={S.fixedTitle} className="fixed-title">Competition Staff — Present All Day</div>
                <div style={S.fixedGrid} className="fixed-grid">
                  <FG label="Drive Team"      names={fixedRoles.driveTeam}      accent="#e94560" />
                  <FG label="Pit Captain"     names={fixedRoles.pitCaptain}     accent="#ff6b35" />
                  <FG label="Lead Programmer" names={fixedRoles.leadProgrammer} accent="#f4a261" />
                  <FG label="Scouting Lead"   names={fixedRoles.scoutingLead}   accent="#0096ff" />
                </div>
              </div>
            )}

            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12, flexWrap:"wrap", gap:12 }}>
              <h2 style={{ ...S.pt, margin:0 }}>Hourly Schedule</h2>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                {effectiveDays.map(day => (
                  <button key={day} style={{
                    ...S.bs, padding:"6px 16px", fontSize:12,
                    background: effectiveDay===day ? "#f4a261" : "transparent",
                    color:      effectiveDay===day ? "#0a0a0f"  : "#f4a261",
                  }} onClick={() => setSelectedDay(day)}>{day}</button>
                ))}
              </div>
            </div>
            <div style={{ marginBottom:16 }} className="no-print">
              <button style={{ ...S.bp, fontSize:12 }} onClick={() => window.print()}>Save as PDF</button>
            </div>

            {effectiveDay && schedule[effectiveDay] && (
              <>
                <div className="print-title">PitSync — {effectiveDay}</div>
                <div style={S.grid} className="sched-grid">
                  {ALL_SLOTS.map(slot => {
                    const sr = schedule[effectiveDay][slot];
                    if (!sr) return null;
                    const anyone = sr.pitProg?.length || sr.pitMech?.length || sr.scouting?.length || sr.recorder?.length || sr.off?.length;
                    if (!anyone) return null;
                    return (
                      <div key={slot} style={S.card} className="card">
                        <div style={S.cardH} className="card-header">{slot}</div>
                        <SR label="Pit Programmer" names={sr.pitProg}   accent="#f4a261" />
                        <SR label="Pit Mechanic"   names={sr.pitMech}   accent="#ff6b35" />
                        <SR label="Scouting"       names={sr.scouting}  accent="#56cfe1" />
                        <SR label="Recorder"       names={sr.recorder}  accent="#a78bfa" />
                        <SR label="Off"            names={sr.off}       accent="#888"    />
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function FG({ label, names, accent }) {
  if (!names?.length) return null;
  return (
    <div style={{ minWidth:130 }}>
      <div className="fixed-label" style={{ fontSize:10, letterSpacing:2, textTransform:"uppercase", color:accent, marginBottom:6 }}>{label}</div>
      {names.map(n => <div key={n} className="fixed-name" style={{ fontSize:13, color:"#ccc", marginBottom:3 }}>{n}</div>)}
    </div>
  );
}

function SR({ label, names, accent }) {
  if (!names?.length) return null;
  return (
    <div style={{ marginBottom:8 }}>
      <div className="slot-label" style={{ fontSize:10, letterSpacing:1, textTransform:"uppercase", color:accent, marginBottom:2 }}>{label}</div>
      <div className="slot-names" style={{ fontSize:13, color:"#bbb", lineHeight:1.5 }}>{names.join(", ")}</div>
    </div>
  );
}

const S = {
  root:       { minHeight:"100vh", background:"#0a0a0f", color:"#e8e8f0", fontFamily:"'Courier New','Consolas',monospace", position:"relative" },
  noise:      { position:"fixed", inset:0, pointerEvents:"none", zIndex:0, opacity:0.15, backgroundImage:`url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E")` },
  spinner:    { width:32, height:32, borderWidth:2, borderStyle:"solid", borderColor:"#1e1e2e", borderTopColor:"#f4a261", borderRadius:"50%", animation:"spin 0.8s linear infinite" },
  header:     { borderBottomWidth:1, borderBottomStyle:"solid", borderBottomColor:"#1e1e2e", background:"rgba(10,10,15,0.98)", backdropFilter:"blur(10px)", position:"sticky", top:0, zIndex:100 },
  hi:         { maxWidth:1100, margin:"0 auto", padding:"0 20px", display:"flex", alignItems:"center", justifyContent:"space-between", height:52 },
  logo:       { fontSize:15, fontWeight:"bold", letterSpacing:4, color:"#f4a261" },
  nav:        { display:"flex", gap:4, flexWrap:"wrap" },
  nb:         { background:"none", borderWidth:1, borderStyle:"solid", borderColor:"transparent", color:"#555", padding:"5px 12px", cursor:"pointer", borderRadius:4, fontFamily:"inherit", fontSize:11, letterSpacing:1 },
  nba:        { borderColor:"#f4a261", color:"#f4a261" },
  main:       { maxWidth:1100, margin:"0 auto", padding:"32px 20px", position:"relative", zIndex:1 },
  ht:         { fontSize:"clamp(40px,8vw,80px)", margin:"0 0 4px", letterSpacing:10, color:"#f4a261", fontWeight:"bold", lineHeight:1 },
  panel:      { maxWidth:640, margin:"0 auto" },
  pt:         { fontSize:22, fontWeight:"bold", color:"#f4a261", letterSpacing:2, marginBottom:8 },
  pd:         { color:"#555", marginBottom:24, fontSize:13, lineHeight:1.8 },
  fg:         { marginBottom:20 },
  lbl:        { display:"block", fontSize:10, letterSpacing:2, color:"#555", marginBottom:8, textTransform:"uppercase" },
  input:      { width:"100%", background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:"#1e1e2e", color:"#e8e8f0", padding:"10px 14px", borderRadius:6, fontFamily:"inherit", fontSize:13, outline:"none", boxSizing:"border-box" },
  fu:         { display:"inline-flex", alignItems:"center", gap:8, background:"#0f0f16", borderWidth:1, borderStyle:"dashed", borderColor:"#2a2a3e", padding:"10px 18px", borderRadius:6, cursor:"pointer", fontSize:13, color:"#888" },
  ok:         { marginLeft:12, color:"#4ade80", fontSize:11 },
  sb:         { marginTop:16, background:"rgba(74,222,128,0.05)", borderWidth:1, borderStyle:"solid", borderColor:"rgba(74,222,128,0.2)", borderRadius:6, padding:"10px 14px", color:"#4ade80", fontSize:12 },
  eb:         { marginBottom:14, background:"rgba(233,69,96,0.06)", borderWidth:1, borderStyle:"solid", borderColor:"rgba(233,69,96,0.2)", borderRadius:6, padding:"10px 14px", color:"#e94560", fontSize:12 },
  bp:         { background:"#f4a261", color:"#0a0a0f", borderWidth:0, borderStyle:"solid", borderColor:"transparent", padding:"10px 24px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:"bold", letterSpacing:1 },
  bs:         { background:"transparent", color:"#f4a261", borderWidth:1, borderStyle:"solid", borderColor:"#f4a261", padding:"8px 18px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:12, letterSpacing:1 },
  dh:         { fontSize:10, letterSpacing:3, color:"#f4a261", textTransform:"uppercase", marginBottom:10, borderBottomWidth:1, borderBottomStyle:"solid", borderBottomColor:"#1a1a2a", paddingBottom:6 },
  fixedBlock: { background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:"#1e1e2e", borderRadius:10, padding:"20px 24px", marginBottom:24 },
  fixedTitle: { fontSize:10, letterSpacing:3, textTransform:"uppercase", color:"#555", marginBottom:14 },
  fixedGrid:  { display:"flex", flexWrap:"wrap", gap:"16px 36px" },
  grid:       { display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(220px,1fr))", gap:10 },
  card:       { background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:"#1a1a2a", borderRadius:8, padding:"14px" },
  cardH:      { fontSize:17, fontWeight:"bold", color:"#f4a261", letterSpacing:2, marginBottom:10, borderBottomWidth:1, borderBottomStyle:"solid", borderBottomColor:"#1a1a2a", paddingBottom:7 },
};

const _s = document.createElement("style");
_s.textContent = `
  @keyframes spin{to{transform:rotate(360deg)}}
  *{-webkit-tap-highlight-color:transparent;box-sizing:border-box}
  input,select,button{font-size:16px!important}
  @media print{
    body{background:white!important;color:black!important;font-family:Arial,sans-serif!important}
    header,nav,button,.no-print{display:none!important}
    .fixed-block{border:1px solid #ccc!important;padding:12px;margin-bottom:16px;background:#f9f9f9!important}
    .fixed-title{color:#333!important;font-size:10px;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px}
    .fixed-grid{display:flex;flex-wrap:wrap;gap:20px 40px}
    .sched-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
    .card{border:1px solid #ddd!important;padding:10px;break-inside:avoid;background:white!important}
    .card-header{font-size:14px;font-weight:bold;color:#333!important;border-bottom:1px solid #eee;padding-bottom:6px;margin-bottom:8px}
    .slot-label{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#666!important;margin-bottom:2px}
    .slot-names{font-size:11px;color:#333!important;line-height:1.5}
    .fixed-label{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#666!important;margin-bottom:4px}
    .fixed-name{font-size:12px;color:#333!important;margin-bottom:2px}
    .print-title{display:block!important;font-size:18px;font-weight:bold;text-align:center;margin-bottom:16px;color:black!important}
  }
  .print-title{display:none}
`;
document.head.appendChild(_s);