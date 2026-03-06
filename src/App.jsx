import { useState, useEffect, useCallback, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, onSnapshot } from "firebase/firestore";

// ─── FIREBASE ─────────────────────────────────────────────────────────────────
const firebaseApp = initializeApp({
  apiKey: "AIzaSyDgV70U0o9hRqKHBrtt2sT26rhY4fY9tFE",
  authDomain: "final-app-robotics.firebaseapp.com",
  projectId: "final-app-robotics",
  storageBucket: "final-app-robotics.firebasestorage.app",
  messagingSenderId: "765533693519",
  appId: "1:765533693519:web:949403cf9a8843c8d7ec3a",
  measurementId: "G-QEZ7P9NZGY"
});
const db = getFirestore(firebaseApp);
const SCHEDULE_DOC = doc(db, "pitsync", "schedule_v2"); // v2 = fresh key, avoids stale data

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const PITS_LIMIT = 4;
const SCOUTING_LIMIT = 5;
const DRIVE_LIMIT = 3;
const SCOUTING_MAX = 6;
const TIME_SLOTS = ["8-9","9-10","10-11","11-12","12-1","1-2","2-3","3-4","4-5","5-6"];

function normalizeSlot(raw) {
  return raw.trim().replace(/\s*(AM|PM)/gi, "").trim();
}

function normalizePosition(roleRaw, pitProgCert, pitMechCert) {
  const r = (roleRaw || "").trim().toLowerCase();
  let position = "Member";
  let alwaysPits = false;
  let alwaysScouting = false;

  if (r.includes("drive"))             { position = "Drive Team"; }
  else if (r.includes("pit captain"))  { position = "Pit Captain"; alwaysPits = true; }
  else if (r.includes("scouting lead")){ position = "Scouting Lead"; alwaysScouting = true; }
  else if (r.includes("lead"))         { position = "Lead"; }

  const hasPitCert =
    (pitProgCert || "").toLowerCase().includes("yes") ||
    (pitMechCert || "").toLowerCase().includes("yes") ||
    (pitProgCert || "").toLowerCase().includes("option");

  if (hasPitCert && position !== "Drive Team" && position !== "Pit Captain") {
    alwaysPits = true;
  }
  return { position, alwaysPits, alwaysScouting };
}

// ─── CSV PARSER ───────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const cols = []; let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"')            { inQ = !inQ; }
    else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ""; }
    else                       { cur += ch; }
  }
  cols.push(cur.trim());
  return cols;
}

function parseCSV(text) {
  const lines = text.trim().split("\n").map(parseCSVLine);
  if (lines.length < 2) return { members: [], days: [] };
  const dataLines = lines.slice(1); // skip header
  const membersMap = {};

  for (const line of dataLines) {
    if (!line || line.length < 5) continue;
    const firstName = (line[1] || "").trim();
    const lastName  = (line[2] || "").trim();
    const name      = `${firstName} ${lastName}`.trim();
    if (!name) continue;

    const friArrival  = (line[4]  || "").trim();
    const satAllDay   = (line[5]  || "").trim().toLowerCase();
    const satHoursRaw = (line[6]  || "").trim();
    const sunAllDay   = (line[7]  || "").trim().toLowerCase();
    const sunHoursRaw = (line[8]  || "").trim();
    const roleRaw     = (line[10] || "").trim();
    const pitProgCert = (line[12] || "").trim();
    const pitMechCert = (line[13] || "").trim();

    const { position, alwaysPits, alwaysScouting } = normalizePosition(roleRaw, pitProgCert, pitMechCert);

    // Friday slots from arrival time answer
    const friLower = friArrival.toLowerCase();
    let friSlots = [];
    if      (friLower.includes("4 pm") || friLower.includes("4pm")) friSlots = ["4-5","5-6"];
    else if (friLower.includes("5 pm") || friLower.includes("5pm")) friSlots = ["5-6"];
    else if (friLower.startsWith("yes"))                             friSlots = ["4-5","5-6"];

    // Saturday slots
    let satSlots = [];
    if      (satAllDay === "yes") satSlots = [...TIME_SLOTS];
    else if (satHoursRaw)         satSlots = satHoursRaw.split(",").map(normalizeSlot).filter(s => TIME_SLOTS.includes(s));

    // Sunday slots
    let sunSlots = [];
    if      (sunAllDay === "yes") sunSlots = [...TIME_SLOTS];
    else if (sunHoursRaw)         sunSlots = sunHoursRaw.split(",").map(normalizeSlot).filter(s => TIME_SLOTS.includes(s));

    const timingsByDay = {};
    if (friSlots.length) timingsByDay["Friday"]   = friSlots;
    if (satSlots.length) timingsByDay["Saturday"]  = satSlots;
    if (sunSlots.length) timingsByDay["Sunday"]    = sunSlots;

    if (membersMap[name]) {
      const ex = membersMap[name];
      for (const [day, slots] of Object.entries(timingsByDay)) {
        if (!ex.timingsByDay[day]) ex.timingsByDay[day] = [];
        for (const s of slots) if (!ex.timingsByDay[day].includes(s)) ex.timingsByDay[day].push(s);
      }
    } else {
      membersMap[name] = { position, alwaysPits, alwaysScouting, timingsByDay };
    }
  }

  const members = Object.entries(membersMap).map(([name, info]) => ({
    name, position: info.position,
    alwaysPits: info.alwaysPits, alwaysScouting: info.alwaysScouting,
    timingsByDay: info.timingsByDay,
    pitsCount: 0, scoutingCount: 0, lastTask: null, timesUsed: 0,
  }));

  const daysOrder = ["Friday","Saturday","Sunday"];
  const days = daysOrder.filter(d => members.some(m => (m.timingsByDay[d] || []).length > 0));
  return { members, days };
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
function canDo(member, role) {
  if (role === "Stands") return true;
  if (member.position === "Drive Team" && role !== "Drive Team") return false;
  if (member.lastTask === role) return false;
  // After pits → forced stands rest
  if (member.lastTask === "Pits" && role !== "Stands") return false;
  return true;
}

function generateSchedule(members, days) {
  const schedule = {};
  for (const day of days) {
    schedule[day] = {};
    for (const m of members) { m.lastTask = null; m.pitsCount = 0; m.scoutingCount = 0; m.timesUsed = 0; }

    for (const slot of TIME_SLOTS) {
      const available = members.filter(m => (m.timingsByDay[day] || []).includes(slot));
      let rem = [...available];
      const driveTeam = [], pits = [], scouting = [], stands = [];
      let pitCaptain = null, scoutingLead = null;

      const remove = (m) => { rem = rem.filter(r => r.name !== m.name); };
      const assign = (m, role) => {
        m.lastTask = role; m.timesUsed++;
        if (role === "Pits" || role === "Pit Captain") m.pitsCount++;
        if (role === "Scouting" || role === "Scouting Lead") m.scoutingCount++;
      };

      // 1) Drive Team
      for (const m of rem.filter(m => m.position === "Drive Team" && canDo(m, "Drive Team")).slice(0, DRIVE_LIMIT)) {
        driveTeam.push(m.name); assign(m, "Drive Team"); remove(m);
      }
      // 2) Pit Captain
      const pcm = rem.find(m => m.position === "Pit Captain" && canDo(m, "Pit Captain"));
      if (pcm) { pitCaptain = pcm.name; assign(pcm, "Pit Captain"); remove(pcm); }
      // 3) Scouting Lead
      const slm = rem.find(m => m.position === "Scouting Lead" && canDo(m, "Scouting Lead"));
      if (slm) { scoutingLead = slm.name; assign(slm, "Scouting Lead"); remove(slm); }
      // 4) Always-pits members (certified)
      for (const m of [...rem].filter(m => m.alwaysPits && canDo(m, "Pits"))) {
        if (pits.length >= PITS_LIMIT) break;
        pits.push(m.name); assign(m, "Pits"); remove(m);
      }
      // 5) Always-scouting members
      for (const m of [...rem].filter(m => m.alwaysScouting && canDo(m, "Scouting") && m.scoutingCount < SCOUTING_MAX)) {
        if (scouting.length >= SCOUTING_LIMIT) break;
        scouting.push(m.name); assign(m, "Scouting"); remove(m);
      }
      // 6) Fill remaining pits
      for (const m of [...rem].filter(m => canDo(m, "Pits"))) {
        if (pits.length >= PITS_LIMIT) break;
        pits.push(m.name); assign(m, "Pits"); remove(m);
      }
      // 7) Fill scouting
      for (const m of [...rem].filter(m => canDo(m, "Scouting") && m.scoutingCount < SCOUTING_MAX)) {
        if (scouting.length >= SCOUTING_LIMIT) break;
        scouting.push(m.name); assign(m, "Scouting"); remove(m);
      }
      // 8) Stands
      for (const m of rem) { stands.push(m.name); assign(m, "Stands"); }

      schedule[day][slot] = { driveTeam, pitCaptain, pits, scoutingLead, scouting, stands };
    }
  }
  return schedule;
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────
function parseSlotTime(day, slot, dayDates) {
  const dateStr = dayDates[day]; if (!dateStr) return null;
  const base = new Date(dateStr); if (isNaN(base)) return null;
  const startH = parseInt(slot.split("-")[0]);
  base.setHours((startH >= 1 && startH <= 7) ? startH + 12 : startH, 0, 0, 0);
  return base;
}
async function requestNotifPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

// ─── ROLE STYLES ──────────────────────────────────────────────────────────────
const ROLE_STYLES = {
  "Drive Team":    { accent: "#e94560", label: "Drive Team" },
  "Pits":          { accent: "#f4a261", label: "Pits" },
  "Pit Captain":   { accent: "#ff6b35", label: "Pit Captain ★" },
  "Scouting":      { accent: "#56cfe1", label: "Scouting" },
  "Scouting Lead": { accent: "#0096ff", label: "Scouting Lead ★" },
  "Stands":        { accent: "#8338ec", label: "Stands" },
};

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState("landing");
  const [csvText, setCsvText] = useState("");
  const [csvLoaded, setCsvLoaded] = useState(false);
  const [schedule, setSchedule] = useState(null);
  const [days, setDays] = useState([]);
  const [selectedDay, setSelectedDay] = useState(null);
  const [dayDates, setDayDates] = useState({ Friday: "", Saturday: "", Sunday: "" });
  const [userName, setUserName] = useState(() => localStorage.getItem("frc_user") || "");
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [parseError, setParseError] = useState("");
  const [syncStatus, setSyncStatus] = useState("idle");
  const [loadingFirebase, setLoadingFirebase] = useState(true);
  const notifTimers = useRef([]);

  // Real-time Firestore listener
  useEffect(() => {
    const unsub = onSnapshot(SCHEDULE_DOC, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.schedule) setSchedule(data.schedule);
        if (data.days && data.days.length > 0) {
          setDays(data.days);
          setSelectedDay(prev => prev || data.days[0]);
        }
        if (data.dayDates) setDayDates(prev => ({ ...prev, ...data.dayDates }));
      }
      setLoadingFirebase(false);
    }, (err) => {
      console.error("Firestore error:", err);
      setLoadingFirebase(false);
    });
    return () => unsub();
  }, []);

  const handleCSVUpload = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setCsvText(ev.target.result); setCsvLoaded(true); setParseError(""); };
    reader.readAsText(file);
  };

  const handleGenerate = async () => {
    if (!csvText) return;
    try {
      const { members, days: parsedDays } = parseCSV(csvText);
      if (!members.length) { setParseError("No members found. Check your CSV."); return; }
      if (!parsedDays.length) { setParseError("No availability days found. Check your CSV."); return; }
      const sched = generateSchedule(members, parsedDays);
      setSyncStatus("saving");
      await setDoc(SCHEDULE_DOC, { schedule: sched, days: parsedDays, dayDates });
      setSyncStatus("saved");
      setParseError("");
      setView("full");
      setTimeout(() => setSyncStatus("idle"), 3000);
    } catch(e) {
      setSyncStatus("error");
      setParseError("Error: " + e.message);
      console.error(e);
    }
  };

  const handleDayDate = async (day, date) => {
    const updated = { ...dayDates, [day]: date };
    setDayDates(updated);
    try { await setDoc(SCHEDULE_DOC, { schedule, days, dayDates: updated }); } catch(e) {}
  };

  const allNames = schedule
    ? [...new Set(Object.values(schedule).flatMap(ds =>
        Object.values(ds).flatMap(s =>
          [...(s.driveTeam||[]), ...(s.pits||[]), ...(s.scouting||[]), ...(s.stands||[]),
           s.pitCaptain, s.scoutingLead].filter(Boolean)
        )
      ))].sort()
    : [];

  const getPersonalSlots = useCallback((name) => {
    if (!schedule || !name) return [];
    const result = [];
    for (const [day, ds] of Object.entries(schedule))
      for (const [slot, r] of Object.entries(ds)) {
        let role = null;
        if (r.driveTeam?.includes(name))  role = "Drive Team";
        else if (r.pitCaptain === name)    role = "Pit Captain";
        else if (r.scoutingLead === name)  role = "Scouting Lead";
        else if (r.pits?.includes(name))   role = "Pits";
        else if (r.scouting?.includes(name)) role = "Scouting";
        else if (r.stands?.includes(name)) role = "Stands";
        if (role) result.push({ day, slot, role });
      }
    return result;
  }, [schedule]);

  const setupNotifs = useCallback(async (name) => {
    const granted = await requestNotifPermission();
    if (!granted) { alert("Please allow notifications in browser settings."); return; }
    setNotifEnabled(true);
    notifTimers.current.forEach(clearTimeout);
    notifTimers.current = [];
    for (const { day, slot, role } of getPersonalSlots(name)) {
      const t = parseSlotTime(day, slot, dayDates); if (!t) continue;
      const delay = t.getTime() - 10 * 60 * 1000 - Date.now(); if (delay < 0) continue;
      notifTimers.current.push(setTimeout(() =>
        new Notification("⚙️ PitSync Reminder", { body: `You're on ${role} at ${slot} (${day}). Get ready!` })
      , delay));
    }
  }, [getPersonalSlots, dayDates]);

  const hasSchedule = !!schedule && days.length > 0;

  if (loadingFirebase) return (
    <div style={{ ...S.root, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:16 }}>
      <div style={S.spinner} />
      <p style={{ color:"#555", fontSize:13, letterSpacing:2 }}>CONNECTING...</p>
    </div>
  );

  return (
    <div style={S.root}>
      <div style={S.noise} />
      <header style={S.header}>
        <div style={S.hi}>
          <div style={S.logo}>
            <span style={S.logoIcon}>⚙</span>
            <span style={S.logoText}>PitSync</span>
          </div>
          <nav style={S.nav}>
            {[
              ["landing", "Home"],
              ["admin",   "Admin"],
              ...(hasSchedule ? [["personal","My Schedule"],["full","Full Schedule"]] : [])
            ].map(([v, label]) => (
              <button key={v} style={view===v ? {...S.nb, ...S.nba} : S.nb} onClick={() => setView(v)}>
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main style={S.main}>

        {/* ── LANDING ── */}
        {view === "landing" && (
          <div style={S.landing}>
            <div style={S.glow} />
            <h1 style={S.ht}>PitSync</h1>
            <p style={S.hs}>FRC Competition Scheduler</p>
            <p style={S.hd}>
              Upload your Google Form CSV, generate a smart role-constrained schedule
              across Friday, Saturday and Sunday, and get push notifications before each of your slots.
            </p>
            <div style={S.hbRow}>
              <button style={S.bp} onClick={() => setView("admin")}>
                {hasSchedule ? "Re-upload CSV →" : "Upload CSV →"}
              </button>
              {hasSchedule && <button style={S.bs} onClick={() => setView("personal")}>My Schedule</button>}
              {hasSchedule && <button style={S.bs} onClick={() => setView("full")}>Full Schedule</button>}
            </div>
            <div style={S.featureRow}>
              {[
                ["🔧", "Pit certified → always in pits"],
                ["🔭", "Scouting Lead → always scouting"],
                ["😮‍💨", "Pits → forced Stands rest next slot"],
                ["☁️",  "Live sync via Firebase"],
                ["📅",  "Fri / Sat / Sun support"],
                ["🔔",  "Push notifications 10 min before"],
              ].map(([ic, lb]) => (
                <div key={lb} style={S.fc}>
                  <span style={S.fi}>{ic}</span>
                  <span style={S.fl}>{lb}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── ADMIN ── */}
        {view === "admin" && (
          <div style={S.panel}>
            <h2 style={S.pt}>Admin — Upload Schedule</h2>
            <p style={S.pd}>Upload once — all devices update instantly via Firebase.</p>

            <div style={S.fg}>
              <label style={S.lbl}>CSV File (Google Form export)</label>
              <label style={S.fu}>
                <span>📂 Choose CSV file</span>
                <input type="file" accept=".csv" onChange={handleCSVUpload} style={{ display:"none" }} />
              </label>
              {csvLoaded && <span style={S.ok}>✓ File loaded</span>}
            </div>

            <div style={S.ib}>
              <strong style={{ color:"#f4a261" }}>Expected columns (auto-parsed):</strong>
              <code style={S.code}>
                Timestamp | First | Last | Phone | Fri arrival | Sat all-day? | Sat hours | Sun all-day? | Sun hours | Years | Role | (skip) | Pit Prog cert | Pit Mech cert
              </code>
              <p style={{ margin:"8px 0 0", fontSize:"12px", color:"#777", lineHeight:1.7 }}>
                <strong style={{ color:"#ccc" }}>Pit certified</strong> → always pits, forced Stands rest after<br/>
                <strong style={{ color:"#ccc" }}>Scouting Lead</strong> → always scouting<br/>
                <strong style={{ color:"#ccc" }}>Drive Team</strong> → only on drive team
              </p>
            </div>

            {parseError && <div style={S.eb}>{parseError}</div>}

            <button
              style={{ ...S.bp, opacity: csvLoaded ? 1 : 0.4, cursor: csvLoaded ? "pointer" : "not-allowed" }}
              onClick={handleGenerate}
              disabled={!csvLoaded}
            >
              {syncStatus === "saving" ? "Saving..." : syncStatus === "saved" ? "✓ Saved!" : "Generate & Sync Schedule"}
            </button>

            {hasSchedule && (
              <>
                <div style={S.sb}>☁️ Schedule is live — all devices update automatically.</div>
                <div style={{ marginTop:28 }}>
                  <p style={{ ...S.lbl, marginBottom:14 }}>SET DATES FOR PUSH NOTIFICATIONS</p>
                  {["Friday","Saturday","Sunday"].map(day => (
                    <div key={day} style={{ display:"flex", alignItems:"center", gap:16, marginBottom:14 }}>
                      <span style={{ ...S.lbl, margin:0, minWidth:68, color:"#f4a261" }}>{day}</span>
                      <input
                        type="date"
                        value={dayDates[day] || ""}
                        onChange={e => handleDayDate(day, e.target.value)}
                        style={{ ...S.input, flex:1 }}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── MY SCHEDULE ── */}
        {view === "personal" && (
          <div style={S.panel}>
            <h2 style={S.pt}>My Schedule</h2>
            {!hasSchedule
              ? <p style={S.pd}>No schedule yet — ask your admin to upload the CSV.</p>
              : (
                <>
                  <div style={S.fg}>
                    <label style={S.lbl}>Your Name</label>
                    <select
                      value={userName}
                      onChange={e => { const n = e.target.value; setUserName(n); localStorage.setItem("frc_user", n); }}
                      style={S.input}
                    >
                      <option value="">— Select your name —</option>
                      {allNames.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>

                  {userName && (
                    <>
                      <button style={{ ...S.bs, marginBottom:28 }} onClick={() => setupNotifs(userName)}>
                        {notifEnabled ? "✓ Notifications Active" : "🔔 Enable Notifications"}
                      </button>

                      {days.map(day => {
                        const mySlots = getPersonalSlots(userName).filter(x => x.day === day);
                        return (
                          <div key={day} style={{ marginBottom:32 }}>
                            <div style={S.dh}>{day}</div>
                            {!mySlots.length
                              ? <p style={{ color:"#444", fontSize:13 }}>No assignments this day.</p>
                              : (
                                <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                                  {mySlots.map(({ slot, role }) => {
                                    const rs = ROLE_STYLES[role] || ROLE_STYLES["Stands"];
                                    return (
                                      <div key={slot + role} style={{
                                        display:"flex", alignItems:"center", justifyContent:"space-between",
                                        background:"#0f0f16",
                                        borderWidth:1, borderStyle:"solid", borderColor: rs.accent,
                                        borderRadius:8, padding:"14px 18px"
                                      }}>
                                        <span style={{ fontSize:18, fontWeight:"bold", letterSpacing:2, color:rs.accent }}>{slot}</span>
                                        <span style={{ background:rs.accent, color:"#0a0a0f", padding:"4px 14px", borderRadius:20, fontSize:12, fontWeight:"bold" }}>
                                          {rs.label}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              )
                            }
                          </div>
                        );
                      })}
                    </>
                  )}
                </>
              )
            }
          </div>
        )}

        {/* ── FULL SCHEDULE ── */}
        {view === "full" && hasSchedule && (
          <div>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:24, flexWrap:"wrap", gap:12 }}>
              <h2 style={{ ...S.pt, margin:0 }}>Full Schedule</h2>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                {days.map(day => (
                  <button
                    key={day}
                    style={{
                      ...S.bs, padding:"6px 18px", fontSize:12,
                      background: selectedDay === day ? "#f4a261" : "transparent",
                      color:      selectedDay === day ? "#0a0a0f"  : "#f4a261",
                    }}
                    onClick={() => setSelectedDay(day)}
                  >
                    {day}
                  </button>
                ))}
              </div>
            </div>

            {selectedDay && schedule[selectedDay] && (
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(260px,1fr))", gap:14 }}>
                {TIME_SLOTS.map(slot => {
                  const sr = schedule[selectedDay][slot];
                  if (!sr) return null;
                  const anyone =
                    (sr.driveTeam?.length)  || sr.pitCaptain ||
                    (sr.pits?.length)        || sr.scoutingLead ||
                    (sr.scouting?.length)    || (sr.stands?.length);
                  if (!anyone) return null;
                  return (
                    <div key={slot} style={S.card}>
                      <div style={S.cardHeader}>{slot}</div>
                      <RR label="Drive Team"      names={sr.driveTeam}                     accent="#e94560" />
                      <RR label="Pit Captain ★"   names={sr.pitCaptain ? [sr.pitCaptain] : []} accent="#ff6b35" />
                      <RR label="Pits"             names={sr.pits}                          accent="#f4a261" />
                      <RR label="Scouting Lead ★" names={sr.scoutingLead ? [sr.scoutingLead] : []} accent="#0096ff" />
                      <RR label="Scouting"         names={sr.scouting}                      accent="#56cfe1" />
                      <RR label="Stands"           names={sr.stands}                        accent="#8338ec" />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

      </main>
    </div>
  );
}

function RR({ label, names, accent }) {
  if (!names?.length) return null;
  return (
    <div style={{ marginBottom:8 }}>
      <span style={{ fontSize:10, letterSpacing:1, textTransform:"uppercase", display:"block", marginBottom:2, color:accent }}>
        {label}
      </span>
      <span style={{ fontSize:13, color:"#bbb" }}>{names.join(", ")}</span>
    </div>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const S = {
  root:    { minHeight:"100vh", background:"#0a0a0f", color:"#e8e8f0", fontFamily:"'Courier New','Consolas',monospace", position:"relative" },
  noise:   { position:"fixed", inset:0, pointerEvents:"none", zIndex:0, opacity:0.25,
             backgroundImage:`url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E")` },
  spinner: { width:32, height:32, borderWidth:2, borderStyle:"solid", borderColor:"#1e1e2e", borderTopColor:"#f4a261", borderRadius:"50%", animation:"spin 0.8s linear infinite" },
  header:  { borderBottomWidth:1, borderBottomStyle:"solid", borderBottomColor:"#1e1e2e", background:"rgba(10,10,15,0.97)", backdropFilter:"blur(10px)", position:"sticky", top:0, zIndex:100 },
  hi:      { maxWidth:1100, margin:"0 auto", padding:"0 24px", display:"flex", alignItems:"center", justifyContent:"space-between", height:56 },
  logo:    { display:"flex", alignItems:"center", gap:10 },
  logoIcon:{ fontSize:18, color:"#f4a261" },
  logoText:{ fontSize:18, fontWeight:"bold", letterSpacing:3, color:"#f4a261" },
  nav:     { display:"flex", gap:4, flexWrap:"wrap" },
  nb:      { background:"none", borderWidth:1, borderStyle:"solid", borderColor:"transparent", color:"#555", padding:"5px 12px", cursor:"pointer", borderRadius:4, fontFamily:"inherit", fontSize:11, letterSpacing:1 },
  nba:     { borderColor:"#f4a261", color:"#f4a261" },
  main:    { maxWidth:1100, margin:"0 auto", padding:"40px 24px", position:"relative", zIndex:1 },
  landing: { textAlign:"center", padding:"60px 0", position:"relative" },
  glow:    { position:"absolute", top:"-60px", left:"50%", transform:"translateX(-50%)", width:700, height:350, borderRadius:"50%", background:"radial-gradient(ellipse,rgba(244,162,97,0.07) 0%,transparent 70%)", pointerEvents:"none" },
  ht:      { fontSize:"clamp(52px,10vw,104px)", margin:"0 0 4px", letterSpacing:10, color:"#f4a261", fontWeight:"bold", lineHeight:1 },
  hs:      { fontSize:14, color:"#444", letterSpacing:5, margin:"0 0 18px", textTransform:"uppercase" },
  hd:      { fontSize:13, color:"#777", maxWidth:500, margin:"0 auto 38px", lineHeight:1.8 },
  hbRow:   { display:"flex", gap:12, justifyContent:"center", marginBottom:52, flexWrap:"wrap" },
  featureRow: { display:"flex", flexWrap:"wrap", gap:12, justifyContent:"center" },
  fc:      { background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:"#1a1a2a", borderRadius:8, padding:"12px 16px", display:"flex", alignItems:"center", gap:10, minWidth:200 },
  fi:      { fontSize:16 },
  fl:      { fontSize:11, color:"#777" },
  panel:   { maxWidth:660, margin:"0 auto" },
  pt:      { fontSize:24, fontWeight:"bold", color:"#f4a261", letterSpacing:2, marginBottom:8 },
  pd:      { color:"#666", marginBottom:28, fontSize:13, lineHeight:1.8 },
  fg:      { marginBottom:20 },
  lbl:     { display:"block", fontSize:10, letterSpacing:2, color:"#555", marginBottom:8, textTransform:"uppercase" },
  input:   { width:"100%", background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:"#1e1e2e", color:"#e8e8f0", padding:"10px 14px", borderRadius:6, fontFamily:"inherit", fontSize:13, outline:"none", boxSizing:"border-box" },
  fu:      { display:"inline-flex", alignItems:"center", gap:8, background:"#0f0f16", borderWidth:1, borderStyle:"dashed", borderColor:"#2a2a3e", padding:"10px 18px", borderRadius:6, cursor:"pointer", fontSize:13, color:"#999" },
  ok:      { marginLeft:12, color:"#4ade80", fontSize:11 },
  ib:      { background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:"#1e1e2e", borderRadius:8, padding:"14px", marginBottom:22, fontSize:12, color:"#777" },
  code:    { display:"block", background:"#080810", borderWidth:1, borderStyle:"solid", borderColor:"#1a1a2a", padding:"7px 12px", borderRadius:4, color:"#56cfe1", fontFamily:"inherit", margin:"7px 0", fontSize:11, whiteSpace:"nowrap", overflowX:"auto" },
  sb:      { marginTop:18, background:"rgba(74,222,128,0.06)", borderWidth:1, borderStyle:"solid", borderColor:"rgba(74,222,128,0.2)", borderRadius:8, padding:"11px 14px", color:"#4ade80", fontSize:12 },
  eb:      { marginBottom:14, background:"rgba(233,69,96,0.07)", borderWidth:1, borderStyle:"solid", borderColor:"rgba(233,69,96,0.25)", borderRadius:8, padding:"11px 14px", color:"#e94560", fontSize:12 },
  bp:      { background:"#f4a261", color:"#0a0a0f", borderWidth:0, borderStyle:"solid", borderColor:"transparent", padding:"10px 24px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:"bold", letterSpacing:1 },
  bs:      { background:"transparent", color:"#f4a261", borderWidth:1, borderStyle:"solid", borderColor:"#f4a261", padding:"8px 20px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:12, letterSpacing:1 },
  dh:      { fontSize:11, letterSpacing:3, color:"#f4a261", textTransform:"uppercase", marginBottom:12, borderBottomWidth:1, borderBottomStyle:"solid", borderBottomColor:"#1a1a2a", paddingBottom:7 },
  card:    { background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:"#1a1a2a", borderRadius:10, padding:"18px" },
  cardHeader: { fontSize:20, fontWeight:"bold", color:"#f4a261", letterSpacing:3, marginBottom:12, borderBottomWidth:1, borderBottomStyle:"solid", borderBottomColor:"#1a1a2a", paddingBottom:8 },
};

// Inject spinner keyframe once
const _s = document.createElement("style");
_s.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(_s);