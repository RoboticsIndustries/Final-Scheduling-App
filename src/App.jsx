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
const SCHEDULE_DOC = doc(db, "pitsync", "schedule_v3");

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const SCOUTING_PER_SLOT = 6;  // exactly 6 scouts per slot, not counting scouting lead
const TIME_SLOTS = ["8-9","9-10","10-11","11-12","12-1","1-2","2-3","3-4","4-5","5-6"];

function normalizeSlot(raw) {
  return raw.trim().replace(/\s*(AM|PM)/gi, "").trim();
}

// Returns position + pit cert flags
function classifyMember(roleRaw, pitProgCert, pitMechCert) {
  const r = (roleRaw || "").trim().toLowerCase();
  let position = "Member";

  if      (r.includes("drive"))          position = "Drive Team";
  else if (r.includes("pit captain"))    position = "Pit Captain";
  else if (r.includes("scouting lead"))  position = "Scouting Lead";
  else if (r.includes("lead"))           position = "Lead";

  const hasPitProg = (pitProgCert || "").toLowerCase().includes("yes") ||
                     (pitProgCert || "").toLowerCase().includes("option");
  const hasPitMech = (pitMechCert || "").toLowerCase().includes("yes") ||
                     (pitMechCert || "").toLowerCase().includes("option");

  return { position, hasPitProg, hasPitMech };
}

// ─── CSV PARSER ───────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const cols = []; let cur = "", inQ = false;
  for (const ch of line) {
    if      (ch === '"')             { inQ = !inQ; }
    else if (ch === ',' && !inQ)     { cols.push(cur.trim()); cur = ""; }
    else                             { cur += ch; }
  }
  cols.push(cur.trim());
  return cols;
}

function parseCSV(text) {
  const lines = text.trim().split("\n").map(parseCSVLine);
  if (lines.length < 2) return { members: [], fixedRoles: {}, days: [] };
  const dataLines = lines.slice(1);
  const membersMap = {};

  for (const line of dataLines) {
    if (!line || line.length < 5) continue;
    const firstName   = (line[1]  || "").trim();
    const lastName    = (line[2]  || "").trim();
    const name        = `${firstName} ${lastName}`.trim();
    if (!name) continue;
    // Skip obvious placeholder / test rows
    const nameLower = name.toLowerCase();
    if (nameLower.includes("filler") || nameLower.includes("first last") ||
        nameLower === "first last" || nameLower.match(/^first \d+ last \d+$/) ||
        nameLower.match(/^first \d* last \d*$/) || (firstName === "First" && lastName === "Last") ||
        nameLower.includes("test") || nameLower.includes("placeholder") ||
        firstName === "" || lastName === "" || firstName === lastName) continue;

    const friArrival  = (line[4]  || "").trim();
    const satAllDay   = (line[5]  || "").trim().toLowerCase();
    const satHoursRaw = (line[6]  || "").trim();
    const sunAllDay   = (line[7]  || "").trim().toLowerCase();
    const sunHoursRaw = (line[8]  || "").trim();
    const roleRaw     = (line[10] || "").trim();
    const col11      = (line[11] || "").trim();
    const pitProgCert = (line[12] || "").trim();
    const pitMechCert = (line[13] || "").trim();
    // Some responses put cert info in col 11 (e.g. "Option 1")
    const pitProgCertFull = pitProgCert || (col11.toLowerCase().includes("option") || col11.toLowerCase().includes("yes") ? col11 : "");
    const pitMechCertFull = pitMechCert;

    const { position, hasPitProg, hasPitMech } = classifyMember(roleRaw, pitProgCertFull, pitMechCertFull);

    // Friday slots
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
      membersMap[name] = { position, hasPitProg, hasPitMech, timingsByDay };
    }
  }

  // Separate fixed roles from schedulable members
  const fixedRoles = { driveTeam: [], pitCaptain: [], leadProgrammer: [], scoutingLead: [] };
  const members = [];

  for (const [name, info] of Object.entries(membersMap)) {
    const p = info.position;
    if (p === "Drive Team")    { fixedRoles.driveTeam.push(name); }
    else if (p === "Pit Captain")   { fixedRoles.pitCaptain.push(name); }
    else if (p === "Scouting Lead") { fixedRoles.scoutingLead.push(name); }
    else if (p === "Lead")          { fixedRoles.leadProgrammer.push(name); }
    else {
      // Only Members get scheduled per-slot
      members.push({
        name,
        hasPitProg: info.hasPitProg,
        hasPitMech: info.hasPitMech,
        timingsByDay: info.timingsByDay,
        lastTask: null,
        pitCount: 0,
        scoutCount: 0,
      });
    }
  }

  const daysOrder = ["Friday","Saturday","Sunday"];
  const days = daysOrder.filter(d =>
    members.some(m => (m.timingsByDay[d] || []).length > 0)
  );

  return { members, fixedRoles, days };
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
function generateSchedule(members, days) {
  const schedule = {};

  for (const day of days) {
    schedule[day] = {};
    // Reset per-day state
    for (const m of members) { m.lastTask = null; m.pitCount = 0; m.scoutCount = 0; }

    for (const slot of TIME_SLOTS) {
      const available = members.filter(m => (m.timingsByDay[day] || []).includes(slot));
      let rem = [...available];

      const pitProg   = [];  // 1 pit programmer
      const pitMech   = [];  // 1 pit mechanic
      const scouting  = [];  // up to SCOUTING_PER_SLOT
      const off       = [];  // everyone else

      const remove = (m) => { rem = rem.filter(r => r.name !== m.name); };
      const assign = (m, role) => {
        m.lastTask = role;
        if (role === "Pit")    m.pitCount++;
        if (role === "Scout")  m.scoutCount++;
        remove(m);
      };

      // 1) Pick 1 pit programmer (certified, not just rested from pit)
      const progCandidates = rem.filter(m =>
        m.hasPitProg && m.lastTask !== "Pit"
      );
      if (progCandidates.length > 0) {
        const m = progCandidates[0];
        pitProg.push(m.name); assign(m, "Pit");
      }

      // 2) Pick 1 pit mechanic (certified, not just rested from pit, different person)
      const mechCandidates = rem.filter(m =>
        m.hasPitMech && m.lastTask !== "Pit"
      );
      if (mechCandidates.length > 0) {
        const m = mechCandidates[0];
        pitMech.push(m.name); assign(m, "Pit");
      }

      // 3) Pick up to SCOUTING_PER_SLOT scouts from remaining
      //    Prefer people who haven't just scouted (avoid back-to-back scouting)
      const scoutCandidates = [
        ...rem.filter(m => m.lastTask !== "Scout"),
        ...rem.filter(m => m.lastTask === "Scout"),
      ];
      for (const m of scoutCandidates) {
        if (scouting.length >= SCOUTING_PER_SLOT) break;
        scouting.push(m.name); assign(m, "Scout");
      }

      // 4) Everyone else is off
      for (const m of rem) { off.push(m.name); m.lastTask = "Off"; }

      schedule[day][slot] = { pitProg, pitMech, scouting, off };
    }
  }

  return schedule;
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────
function parseSlotTime(day, slot, dayDates) {
  const dateStr = dayDates[day]; if (!dateStr) return null;
  const base = new Date(dateStr + "T00:00:00");
  if (isNaN(base)) return null;
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
  "Pit Programmer": { accent: "#f4a261" },
  "Pit Mechanic":   { accent: "#ff6b35" },
  "Scouting":       { accent: "#56cfe1" },
  "Off":            { accent: "#555"    },
};

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState("loading");
  const [csvText, setCsvText]       = useState("");
  const [csvLoaded, setCsvLoaded]   = useState(false);
  const [schedule, setSchedule]     = useState(null);
  const [fixedRoles, setFixedRoles] = useState(null);
  const [days, setDays]             = useState([]);
  const [selectedDay, setSelectedDay] = useState(null);
  const [dayDates, setDayDates]     = useState({ Friday: "", Saturday: "", Sunday: "" });
  const [userName, setUserName]     = useState(() => localStorage.getItem("frc_user") || "");
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [parseError, setParseError] = useState("");
  const [syncStatus, setSyncStatus] = useState("idle");
  const notifTimers = useRef([]);

  // ── Firestore real-time listener ──
  useEffect(() => {
    const unsub = onSnapshot(SCHEDULE_DOC, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.schedule)   setSchedule(data.schedule);
        if (data.fixedRoles) setFixedRoles(data.fixedRoles);
        if (data.days && data.days.length > 0) {
          setDays(data.days);
          setSelectedDay(prev =>
            prev && data.days.includes(prev) ? prev : data.days[0]
          );
        }
        if (data.dayDates) setDayDates(prev => ({ ...prev, ...data.dayDates }));
        // Auto-navigate to schedule on any device
        setView(prev => (prev === "loading" || prev === "landing") ? "full" : prev);
      } else {
        // No schedule yet — go to landing
        setView("landing");
      }
    }, (err) => {
      console.error("Firestore:", err);
      setView("landing");
    });
    return () => unsub();
  }, []);

  // ── CSV upload ──
  const handleCSVUpload = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setCsvText(ev.target.result); setCsvLoaded(true); setParseError(""); };
    reader.readAsText(file);
  };

  // ── Generate + save ──
  const handleGenerate = async () => {
    if (!csvText) return;
    try {
      const { members, fixedRoles: fr, days: parsedDays } = parseCSV(csvText);
      if (!members.length && !Object.values(fr).flat().length) {
        setParseError("No members found. Check your CSV."); return;
      }
      const sched = generateSchedule(members, parsedDays);
      setSyncStatus("saving");
      await setDoc(SCHEDULE_DOC, { schedule: sched, fixedRoles: fr, days: parsedDays, dayDates });
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
    try { await setDoc(SCHEDULE_DOC, { schedule, fixedRoles, days, dayDates: updated }); } catch(e) {}
  };

  // ── All names for personal schedule dropdown ──
  const allNames = schedule
    ? [...new Set(Object.values(schedule).flatMap(ds =>
        Object.values(ds).flatMap(s =>
          [...(s.pitProg||[]), ...(s.pitMech||[]), ...(s.scouting||[]), ...(s.off||[])]
        )
      ))].sort()
    : [];

  // ── Personal slots ──
  const getPersonalSlots = useCallback((name) => {
    if (!schedule || !name) return [];
    const result = [];
    for (const [day, ds] of Object.entries(schedule))
      for (const [slot, r] of Object.entries(ds)) {
        let role = null;
        if (r.pitProg?.includes(name))    role = "Pit Programmer";
        else if (r.pitMech?.includes(name))   role = "Pit Mechanic";
        else if (r.scouting?.includes(name))  role = "Scouting";
        else if (r.off?.includes(name))       role = "Off";
        if (role) result.push({ day, slot, role });
      }
    return result;
  }, [schedule]);

  // ── Notifications ──
  const setupNotifs = useCallback(async (name) => {
    const granted = await requestNotifPermission();
    if (!granted) { alert("Please allow notifications in browser settings."); return; }
    setNotifEnabled(true);
    notifTimers.current.forEach(clearTimeout);
    notifTimers.current = [];
    for (const { day, slot, role } of getPersonalSlots(name)) {
      if (role === "Off") continue;
      const t = parseSlotTime(day, slot, dayDates); if (!t) continue;
      const delay = t.getTime() - 10 * 60 * 1000 - Date.now(); if (delay < 0) continue;
      notifTimers.current.push(setTimeout(() =>
        new Notification("PitSync Reminder", { body: `You are on ${role} at ${slot} (${day}).` })
      , delay));
    }
  }, [getPersonalSlots, dayDates]);

  // ── Derived state ──
  const effectiveDays = days.length > 0
    ? days
    : schedule
      ? ["Friday","Saturday","Sunday"].filter(d => schedule[d] && Object.keys(schedule[d]).length > 0)
      : [];
  const effectiveDay = selectedDay && effectiveDays.includes(selectedDay)
    ? selectedDay
    : effectiveDays[0] || null;
  const hasSchedule = !!schedule && effectiveDays.length > 0;

  // ── Loading spinner ──
  if (view === "loading") return (
    <div style={{ ...S.root, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:16 }}>
      <div style={S.spinner} />
      <p style={{ color:"#555", fontSize:13, letterSpacing:2 }}>CONNECTING...</p>
    </div>
  );

  return (
    <div style={S.root}>
      <div style={S.noise} />

      {/* ── HEADER ── */}
      <header style={S.header}>
        <div style={S.hi}>
          <div style={S.logo}>
            <span style={S.logoText}>PITSYNC</span>
          </div>
          <nav style={S.nav}>
            {[
              ["admin",    "Admin"],
              ...(hasSchedule ? [["personal","My Schedule"],["full","Schedule"]] : [])
            ].map(([v, label]) => (
              <button key={v}
                style={view === v ? { ...S.nb, ...S.nba } : S.nb}
                onClick={() => setView(v)}>
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main style={S.main}>

        {/* ── LANDING (no schedule yet) ── */}
        {view === "landing" && (
          <div style={{ textAlign:"center", paddingTop:80 }}>
            <h1 style={S.ht}>PITSYNC</h1>
            <p style={{ color:"#555", fontSize:14, letterSpacing:3, marginBottom:32 }}>FRC COMPETITION SCHEDULER</p>
            <p style={{ color:"#666", fontSize:13, maxWidth:400, margin:"0 auto 40px", lineHeight:1.8 }}>
              No schedule has been uploaded yet. Ask your admin to upload the CSV.
            </p>
            <button style={S.bp} onClick={() => setView("admin")}>Go to Admin</button>
          </div>
        )}

        {/* ── ADMIN ── */}
        {view === "admin" && (
          <div style={S.panel}>
            <h2 style={S.pt}>Admin — Upload Schedule</h2>
            <p style={S.pd}>Upload once. All devices update instantly.</p>

            <div style={S.fg}>
              <label style={S.lbl}>CSV File</label>
              <label style={S.fu}>
                Choose CSV file
                <input type="file" accept=".csv" onChange={handleCSVUpload} style={{ display:"none" }} />
              </label>
              {csvLoaded && <span style={S.ok}>File loaded</span>}
            </div>

            <div style={S.ib}>
              <strong style={{ color:"#f4a261" }}>Expected columns:</strong>
              <code style={S.code}>Timestamp | First | Last | Phone | Fri arrival | Sat all-day? | Sat hours | Sun all-day? | Sun hours | Years | Role | (skip) | Pit Prog cert | Pit Mech cert</code>
              <p style={{ margin:"8px 0 0", fontSize:"12px", color:"#666", lineHeight:1.7 }}>
                Drive Team, Pit Captain, Lead Programmer, Scouting Lead are shown as a fixed block — not scheduled per slot.<br/>
                All others are scheduled for Pit Programmer, Pit Mechanic, Scouting, or Off each hour.
              </p>
            </div>

            {parseError && <div style={S.eb}>{parseError}</div>}

            <button
              style={{ ...S.bp, opacity: csvLoaded ? 1 : 0.4, cursor: csvLoaded ? "pointer" : "not-allowed" }}
              onClick={handleGenerate}
              disabled={!csvLoaded}
            >
              {syncStatus === "saving" ? "Saving..." : syncStatus === "saved" ? "Saved" : "Generate & Sync Schedule"}
            </button>

            {hasSchedule && (
              <>
                <div style={S.sb}>Schedule is live. All devices update automatically.</div>
                <div style={{ marginTop:28 }}>
                  <p style={{ ...S.lbl, marginBottom:14 }}>Competition Dates (for notifications)</p>
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
              ? <p style={S.pd}>No schedule yet.</p>
              : (
                <>
                  <div style={S.fg}>
                    <label style={S.lbl}>Your Name</label>
                    <select
                      value={userName}
                      onChange={e => { const n = e.target.value; setUserName(n); localStorage.setItem("frc_user", n); }}
                      style={S.input}
                    >
                      <option value="">Select your name</option>
                      {allNames.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>

                  {userName && (
                    <>
                      <button style={{ ...S.bs, marginBottom:28 }} onClick={() => setupNotifs(userName)}>
                        {notifEnabled ? "Notifications Active" : "Enable Notifications"}
                      </button>

                      {effectiveDays.map(day => {
                        const mySlots = getPersonalSlots(userName).filter(x => x.day === day);
                        return (
                          <div key={day} style={{ marginBottom:32 }}>
                            <div style={S.dh}>{day}</div>
                            {!mySlots.length
                              ? <p style={{ color:"#444", fontSize:13 }}>No assignments this day.</p>
                              : (
                                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                                  {mySlots.map(({ slot, role }) => {
                                    const accent = ROLE_STYLES[role]?.accent || "#555";
                                    return (
                                      <div key={slot + role} style={{
                                        display:"flex", alignItems:"center", justifyContent:"space-between",
                                        background:"#0f0f16",
                                        borderWidth:1, borderStyle:"solid", borderColor: accent,
                                        borderRadius:6, padding:"12px 16px"
                                      }}>
                                        <span style={{ fontSize:16, fontWeight:"bold", color: accent, letterSpacing:1 }}>{slot}</span>
                                        <span style={{ fontSize:12, color: accent, letterSpacing:1, textTransform:"uppercase" }}>{role}</span>
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
            {/* Fixed roles block */}
            {fixedRoles && (
              <div style={S.fixedBlock}>
                <div style={S.fixedTitle}>Competition Staff — Present All Weekend</div>
                <div style={S.fixedGrid}>
                  <FixedGroup label="Drive Team"      names={fixedRoles.driveTeam}     accent="#e94560" />
                  <FixedGroup label="Pit Captain"     names={fixedRoles.pitCaptain}    accent="#ff6b35" />
                  <FixedGroup label="Lead Programmer" names={fixedRoles.leadProgrammer} accent="#f4a261" />
                  <FixedGroup label="Scouting Lead"   names={fixedRoles.scoutingLead}  accent="#0096ff" />
                </div>
              </div>
            )}

            {/* Day selector */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20, flexWrap:"wrap", gap:12 }}>
              <h2 style={{ ...S.pt, margin:0 }}>Hourly Schedule</h2>
              <div style={{ display:"flex", gap:8 }}>
                {effectiveDays.map(day => (
                  <button key={day}
                    style={{
                      ...S.bs, padding:"6px 16px", fontSize:12,
                      background: effectiveDay === day ? "#f4a261" : "transparent",
                      color:      effectiveDay === day ? "#0a0a0f"  : "#f4a261",
                    }}
                    onClick={() => setSelectedDay(day)}
                  >
                    {day}
                  </button>
                ))}
              </div>
            </div>

            {/* Schedule grid */}
            {effectiveDay && schedule[effectiveDay] && (
              <div style={S.schedGrid}>
                {TIME_SLOTS.map(slot => {
                  const sr = schedule[effectiveDay][slot];
                  if (!sr) return null;
                  const hasAnyone = sr.pitProg?.length || sr.pitMech?.length || sr.scouting?.length || sr.off?.length;
                  if (!hasAnyone) return null;
                  return (
                    <div key={slot} style={S.card}>
                      <div style={S.cardHeader}>{slot}</div>
                      <SlotRow label="Pit Programmer" names={sr.pitProg}   accent="#f4a261" />
                      <SlotRow label="Pit Mechanic"   names={sr.pitMech}   accent="#ff6b35" />
                      <SlotRow label="Scouting"        names={sr.scouting}  accent="#56cfe1" />
                      <SlotRow label="Off"             names={sr.off}       accent="#444"    />
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

// ── Sub-components ────────────────────────────────────────────────────────────
function FixedGroup({ label, names, accent }) {
  if (!names?.length) return null;
  return (
    <div style={{ minWidth:140 }}>
      <div style={{ fontSize:10, letterSpacing:2, textTransform:"uppercase", color: accent, marginBottom:6 }}>{label}</div>
      {names.map(n => (
        <div key={n} style={{ fontSize:13, color:"#ccc", marginBottom:3 }}>{n}</div>
      ))}
    </div>
  );
}

function SlotRow({ label, names, accent }) {
  if (!names?.length) return null;
  return (
    <div style={{ marginBottom:10 }}>
      <div style={{ fontSize:10, letterSpacing:1, textTransform:"uppercase", color: accent, marginBottom:3 }}>{label}</div>
      <div style={{ fontSize:13, color:"#bbb", lineHeight:1.6 }}>{names.join(", ")}</div>
    </div>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const S = {
  root:    { minHeight:"100vh", background:"#0a0a0f", color:"#e8e8f0", fontFamily:"'Courier New','Consolas',monospace", position:"relative" },
  noise:   { position:"fixed", inset:0, pointerEvents:"none", zIndex:0, opacity:0.2,
             backgroundImage:`url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E")` },
  spinner: { width:32, height:32, borderWidth:2, borderStyle:"solid", borderColor:"#1e1e2e", borderTopColor:"#f4a261", borderRadius:"50%", animation:"spin 0.8s linear infinite" },
  header:  { borderBottomWidth:1, borderBottomStyle:"solid", borderBottomColor:"#1e1e2e", background:"rgba(10,10,15,0.98)", backdropFilter:"blur(10px)", position:"sticky", top:0, zIndex:100 },
  hi:      { maxWidth:1100, margin:"0 auto", padding:"0 20px", display:"flex", alignItems:"center", justifyContent:"space-between", height:52 },
  logo:    { display:"flex", alignItems:"center" },
  logoText:{ fontSize:15, fontWeight:"bold", letterSpacing:4, color:"#f4a261" },
  nav:     { display:"flex", gap:4, flexWrap:"wrap" },
  nb:      { background:"none", borderWidth:1, borderStyle:"solid", borderColor:"transparent", color:"#555", padding:"5px 12px", cursor:"pointer", borderRadius:4, fontFamily:"inherit", fontSize:11, letterSpacing:1 },
  nba:     { borderColor:"#f4a261", color:"#f4a261" },
  main:    { maxWidth:1100, margin:"0 auto", padding:"32px 20px", position:"relative", zIndex:1 },
  ht:      { fontSize:"clamp(40px,8vw,80px)", margin:"0 0 4px", letterSpacing:10, color:"#f4a261", fontWeight:"bold", lineHeight:1 },
  panel:   { maxWidth:640, margin:"0 auto" },
  pt:      { fontSize:22, fontWeight:"bold", color:"#f4a261", letterSpacing:2, marginBottom:8 },
  pd:      { color:"#555", marginBottom:24, fontSize:13, lineHeight:1.8 },
  fg:      { marginBottom:20 },
  lbl:     { display:"block", fontSize:10, letterSpacing:2, color:"#555", marginBottom:8, textTransform:"uppercase" },
  input:   { width:"100%", background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:"#1e1e2e", color:"#e8e8f0", padding:"10px 14px", borderRadius:6, fontFamily:"inherit", fontSize:13, outline:"none", boxSizing:"border-box" },
  fu:      { display:"inline-flex", alignItems:"center", gap:8, background:"#0f0f16", borderWidth:1, borderStyle:"dashed", borderColor:"#2a2a3e", padding:"10px 18px", borderRadius:6, cursor:"pointer", fontSize:13, color:"#888" },
  ok:      { marginLeft:12, color:"#4ade80", fontSize:11 },
  ib:      { background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:"#1e1e2e", borderRadius:8, padding:"14px", marginBottom:20, fontSize:12, color:"#666" },
  code:    { display:"block", background:"#080810", borderWidth:1, borderStyle:"solid", borderColor:"#1a1a2a", padding:"7px 12px", borderRadius:4, color:"#56cfe1", fontFamily:"inherit", margin:"7px 0", fontSize:10, whiteSpace:"nowrap", overflowX:"auto" },
  sb:      { marginTop:16, background:"rgba(74,222,128,0.05)", borderWidth:1, borderStyle:"solid", borderColor:"rgba(74,222,128,0.2)", borderRadius:6, padding:"10px 14px", color:"#4ade80", fontSize:12 },
  eb:      { marginBottom:14, background:"rgba(233,69,96,0.06)", borderWidth:1, borderStyle:"solid", borderColor:"rgba(233,69,96,0.2)", borderRadius:6, padding:"10px 14px", color:"#e94560", fontSize:12 },
  bp:      { background:"#f4a261", color:"#0a0a0f", borderWidth:0, borderStyle:"solid", borderColor:"transparent", padding:"10px 24px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:"bold", letterSpacing:1 },
  bs:      { background:"transparent", color:"#f4a261", borderWidth:1, borderStyle:"solid", borderColor:"#f4a261", padding:"8px 18px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:12, letterSpacing:1 },
  dh:      { fontSize:10, letterSpacing:3, color:"#f4a261", textTransform:"uppercase", marginBottom:12, borderBottomWidth:1, borderBottomStyle:"solid", borderBottomColor:"#1a1a2a", paddingBottom:6 },
  fixedBlock: { background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:"#1e1e2e", borderRadius:10, padding:"20px 24px", marginBottom:28 },
  fixedTitle: { fontSize:10, letterSpacing:3, textTransform:"uppercase", color:"#555", marginBottom:16 },
  fixedGrid:  { display:"flex", flexWrap:"wrap", gap:"20px 40px" },
  schedGrid:  { display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(240px,1fr))", gap:12 },
  card:    { background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:"#1a1a2a", borderRadius:8, padding:"16px" },
  cardHeader: { fontSize:18, fontWeight:"bold", color:"#f4a261", letterSpacing:2, marginBottom:12, borderBottomWidth:1, borderBottomStyle:"solid", borderBottomColor:"#1a1a2a", paddingBottom:8 },
};

const _s = document.createElement("style");
_s.textContent = `@keyframes spin { to { transform: rotate(360deg); } } * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; } select, input, button { font-size: 16px !important; } @media (max-width: 600px) { body { font-size: 14px; } }`;
document.head.appendChild(_s);