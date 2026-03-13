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
const SCHEDULE_DOC = doc(db, "pitsync", "schedule_v5");

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const SCOUTING_PER_SLOT = 6;
const TIME_SLOTS = ["8-9","9-10","10-11","11-12","12-1","1-2","2-3","3-4","4-5","5-6"];

// ─── PINNED CONSTRAINTS ───────────────────────────────────────────────────────
// Kunj must be in pits at same time as Aryan, Arjun, Sunny, Aadi
// Aryan must be in pits at same time as Jake and Shaun
// Pinned slots chosen where all required members are available
const PINNED_PIT_SLOTS = {
  Saturday: ["10-11", "1-2"],
  Sunday:   ["10-11", "1-2"],
};
// Members forced into pits at pinned slots
const PINNED_PIT_MECH_GROUP  = ["Kunj Tailor", "Arjun Iyer", "Sunny Kota", "Aadi Patel"];
const PINNED_PIT_PROG_GROUP  = ["Aryan Mitra", "Jake Widmann", "Shaun Mathew"];

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function normalizeSlot(raw) {
  return raw.trim().replace(/\s*(AM|PM)/gi, "").trim();
}

function classifyMember(roleRaw, col11, pitProgCert, pitMechCert) {
  const r = (roleRaw || "").trim().toLowerCase();
  let position = "Member";
  if      (r.includes("drive"))          position = "Drive Team";
  else if (r.includes("pit captain"))    position = "Pit Captain";
  else if (r.includes("scouting lead"))  position = "Scouting Lead";
  else if (r.includes("lead"))           position = "Lead Programmer";

  // Check all cert columns including col11
  const allCerts = [col11, pitProgCert, pitMechCert].map(c => (c||"").toLowerCase());
  const hasPitProg = allCerts.some(c => c.includes("yes")) &&
    !allCerts[2].includes("yes")  // col13 (mech) didn't say yes
    ? allCerts[0].includes("yes") || allCerts[1].includes("yes") || allCerts[0].includes("option")
    : (allCerts[1].includes("yes") || allCerts[0].includes("option"));
  const hasPitMech = allCerts[2].includes("yes");

  return { position, hasPitProg, hasPitMech };
}

// ─── CSV PARSER ───────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const cols = []; let cur = "", inQ = false;
  for (const ch of line) {
    if      (ch === '"')           { inQ = !inQ; }
    else if (ch === ',' && !inQ)   { cols.push(cur.trim()); cur = ""; }
    else                           { cur += ch; }
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

    // Skip placeholder rows
    const nl = name.toLowerCase();
    if (nl.includes("filler") || nl.match(/^first\s*\d*\s*last\s*\d*$/i) ||
        (firstName === "First") || firstName === "" || lastName === "") continue;

    const friArrival  = (line[4]  || "").trim();
    const satAllDay   = (line[5]  || "").trim().toLowerCase();
    const satHoursRaw = (line[6]  || "").trim();
    const sunAllDay   = (line[7]  || "").trim().toLowerCase();
    const sunHoursRaw = (line[8]  || "").trim();
    const roleRaw     = (line[10] || "").trim();
    const col11       = (line[11] || "").trim();
    const pitProgCert = (line[12] || "").trim();
    const pitMechCert = (line[13] || "").trim();

    const { position, hasPitProg, hasPitMech } = classifyMember(roleRaw, col11, pitProgCert, pitMechCert);

    const friLower = friArrival.toLowerCase();
    let friSlots = [];
    if      (friLower.includes("4 pm") || friLower.includes("4pm")) friSlots = ["4-5","5-6"];
    else if (friLower.includes("5 pm") || friLower.includes("5pm")) friSlots = ["5-6"];
    else if (friLower.startsWith("yes"))                             friSlots = ["4-5","5-6"];

    let satSlots = satAllDay === "yes" ? [...TIME_SLOTS]
      : (satHoursRaw ? satHoursRaw.split(",").map(normalizeSlot).filter(s => TIME_SLOTS.includes(s)) : []);
    let sunSlots = sunAllDay === "yes" ? [...TIME_SLOTS]
      : (sunHoursRaw ? sunHoursRaw.split(",").map(normalizeSlot).filter(s => TIME_SLOTS.includes(s)) : []);

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

  // Separate fixed roles (never scheduled per slot) from schedulable members
  const fixedRoles = { driveTeam: [], pitCaptain: [], leadProgrammer: [], scoutingLead: [] };
  const members = [];

  for (const [name, info] of Object.entries(membersMap)) {
    switch (info.position) {
      case "Drive Team":      fixedRoles.driveTeam.push(name);      break;
      case "Pit Captain":     fixedRoles.pitCaptain.push(name);     break;
      case "Scouting Lead":   fixedRoles.scoutingLead.push(name);   break;
      case "Lead Programmer": fixedRoles.leadProgrammer.push(name); break;
      default:
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
  const days = daysOrder.filter(d => members.some(m => (m.timingsByDay[d] || []).length > 0));
  return { members, fixedRoles, days };
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
function generateSchedule(members, days) {
  const schedule = {};
  const byName = Object.fromEntries(members.map(m => [m.name, m]));

  for (const day of days) {
    schedule[day] = {};
    for (const m of members) { m.lastTask = null; m.pitCount = 0; m.scoutCount = 0; }

    const pinnedSlots = PINNED_PIT_SLOTS[day] || [];

    for (const slot of TIME_SLOTS) {
      const avail = (name) => (byName[name]?.timingsByDay[day] || []).includes(slot);
      const notJustDidPit = (name) => byName[name]?.lastTask !== "Pit";

      let rem = members.filter(m => (m.timingsByDay[day] || []).includes(slot));
      const pitProg  = [];
      const pitMech  = [];
      const scouting = [];
      const off      = [];

      const remove = (m) => { rem = rem.filter(r => r.name !== m.name); };
      const assign = (m, role) => {
        m.lastTask = role;
        if (role === "Pit") m.pitCount++;
        if (role === "Scout") m.scoutCount++;
        remove(m);
      };

      const isPinned = pinnedSlots.includes(slot);

      if (isPinned) {
        // ── Pinned slot: force the constrained groups into pits ──

        // Pit prog group: Aryan + Jake + Shaun (if available and not just did pit)
        for (const name of PINNED_PIT_PROG_GROUP) {
          const m = byName[name];
          if (m && avail(name) && notJustDidPit(name)) {
            pitProg.push(name); assign(m, "Pit");
          }
        }

        // Pit mech group: Kunj + Arjun + Sunny + Aadi (if available and not just did pit)
        for (const name of PINNED_PIT_MECH_GROUP) {
          const m = byName[name];
          if (m && avail(name) && notJustDidPit(name)) {
            pitMech.push(name); assign(m, "Pit");
          }
        }

      } else {
        // ── Normal slot: rotate certified members ──

        // 1 pit programmer (certified, not just rested from pit, not in pinned groups this slot)
        const progCandidates = rem.filter(m => m.hasPitProg && m.lastTask !== "Pit");
        if (progCandidates.length > 0) {
          const m = progCandidates[0];
          pitProg.push(m.name); assign(m, "Pit");
        }

        // 1 pit mechanic (certified, not just rested from pit)
        const mechCandidates = rem.filter(m => m.hasPitMech && m.lastTask !== "Pit");
        if (mechCandidates.length > 0) {
          const m = mechCandidates[0];
          pitMech.push(m.name); assign(m, "Pit");
        }
      }

      // Scouting: up to SCOUTING_PER_SLOT from remaining, prefer those who haven't just scouted
      const scoutPool = [
        ...rem.filter(m => m.lastTask !== "Scout"),
        ...rem.filter(m => m.lastTask === "Scout"),
      ];
      for (const m of scoutPool) {
        if (scouting.length >= SCOUTING_PER_SLOT) break;
        scouting.push(m.name); assign(m, "Scout");
      }

      // Everyone else is off
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

// ─── ROLE ACCENT COLORS ───────────────────────────────────────────────────────
const ACCENT = {
  "Pit Programmer": "#f4a261",
  "Pit Mechanic":   "#ff6b35",
  "Scouting":       "#56cfe1",
  "Off":            "#444",
};

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView]             = useState("loading");
  const [csvText, setCsvText]       = useState("");
  const [csvLoaded, setCsvLoaded]   = useState(false);
  const [schedule, setSchedule]     = useState(null);
  const [fixedRoles, setFixedRoles] = useState(null);
  const [days, setDays]             = useState([]);
  const [selectedDay, setSelectedDay] = useState(null);
  const [dayDates, setDayDates]     = useState({ Friday:"", Saturday:"", Sunday:"" });
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
        // Set all state in one batch so nothing renders half-loaded
        if (data.fixedRoles) setFixedRoles(data.fixedRoles);
        if (data.dayDates)   setDayDates(prev => ({ ...prev, ...data.dayDates }));
        if (data.days && data.days.length > 0) {
          setDays(data.days);
          setSelectedDay(prev => (prev && data.days.includes(prev)) ? prev : data.days[0]);
        }
        // Set schedule last — this is what triggers hasSchedule to become true
        if (data.schedule) {
          setSchedule(data.schedule);
          setView("full");
        }
      } else {
        setView("landing");
      }
    }, () => setView("landing"));
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
      const { members, fixedRoles: fr, days: parsedDays } = parseCSV(csvText);
      if (!members.length) { setParseError("No schedulable members found."); return; }
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

  const allNames = schedule
    ? [...new Set(Object.values(schedule).flatMap(ds =>
        Object.values(ds).flatMap(s =>
          [...(s.pitProg||[]), ...(s.pitMech||[]), ...(s.scouting||[]), ...(s.off||[])]
        )
      ))].sort()
    : [];

  const getPersonalSlots = useCallback((name) => {
    if (!schedule || !name) return [];
    const result = [];
    for (const [day, ds] of Object.entries(schedule))
      for (const [slot, r] of Object.entries(ds)) {
        let role = null;
        if (r.pitProg?.includes(name))   role = "Pit Programmer";
        else if (r.pitMech?.includes(name))  role = "Pit Mechanic";
        else if (r.scouting?.includes(name)) role = "Scouting";
        else if (r.off?.includes(name))      role = "Off";
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
      if (role === "Off") continue;
      const t = parseSlotTime(day, slot, dayDates); if (!t) continue;
      const delay = t.getTime() - 10 * 60 * 1000 - Date.now(); if (delay < 0) continue;
      notifTimers.current.push(setTimeout(() =>
        new Notification("PitSync Reminder", { body: `You are on ${role} at ${slot} (${day}).` })
      , delay));
    }
  }, [getPersonalSlots, dayDates]);

  const effectiveDays = days.length > 0 ? days
    : schedule ? ["Friday","Saturday","Sunday"].filter(d => schedule[d] && Object.keys(schedule[d]).length > 0)
    : [];
  const effectiveDay = (selectedDay && effectiveDays.includes(selectedDay))
    ? selectedDay : (effectiveDays[0] || null);
  const hasSchedule = !!schedule && effectiveDays.length > 0;

  // ── Loading ──
  if (view === "loading") return (
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
          <span style={S.logoText}>PITSYNC</span>
          <nav style={S.nav}>
            {[["admin","Admin"], ...(hasSchedule ? [["personal","My Schedule"],["full","Schedule"]] : [])]
              .map(([v, label]) => (
                <button key={v} style={view===v ? {...S.nb,...S.nba} : S.nb} onClick={() => setView(v)}>
                  {label}
                </button>
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
            <p style={{ color:"#555", fontSize:13, maxWidth:400, margin:"0 auto 40px", lineHeight:1.8 }}>
              No schedule uploaded yet. Ask your admin to upload the CSV.
            </p>
            <button style={S.bp} onClick={() => setView("admin")}>Go to Admin</button>
          </div>
        )}

        {/* ADMIN */}
        {view === "admin" && (
          <div style={S.panel}>
            <h2 style={S.pt}>Admin</h2>
            <p style={S.pd}>Upload once. All devices update instantly.</p>

            <div style={S.fg}>
              <label style={S.lbl}>CSV File</label>
              <label style={S.fu}>
                Choose CSV file
                <input type="file" accept=".csv" onChange={handleCSVUpload} style={{ display:"none" }} />
              </label>
              {csvLoaded && <span style={S.ok}>File loaded</span>}
            </div>

            {parseError && <div style={S.eb}>{parseError}</div>}

            <button
              style={{ ...S.bp, opacity:csvLoaded?1:0.4, cursor:csvLoaded?"pointer":"not-allowed" }}
              onClick={handleGenerate} disabled={!csvLoaded}
            >
              {syncStatus==="saving" ? "Saving..." : syncStatus==="saved" ? "Saved" : "Generate & Sync Schedule"}
            </button>

            {hasSchedule && (
              <>
                <div style={S.sb}>Schedule is live. All devices update automatically.</div>
                <div style={{ marginTop:28 }}>
                  <p style={{ ...S.lbl, marginBottom:14 }}>Competition Dates (for notifications)</p>
                  {["Friday","Saturday","Sunday"].map(day => (
                    <div key={day} style={{ display:"flex", alignItems:"center", gap:16, marginBottom:14 }}>
                      <span style={{ ...S.lbl, margin:0, minWidth:68, color:"#f4a261" }}>{day}</span>
                      <input type="date" value={dayDates[day]||""} onChange={e => handleDayDate(day, e.target.value)} style={{ ...S.input, flex:1 }} />
                    </div>
                  ))}
                </div>
              </>
            )}
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
                            : <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                                {mySlots.map(({ slot, role }) => {
                                  const accent = ACCENT[role] || "#555";
                                  return (
                                    <div key={slot+role} style={{
                                      display:"flex", alignItems:"center", justifyContent:"space-between",
                                      background:"#0f0f16", borderWidth:1, borderStyle:"solid",
                                      borderColor:accent, borderRadius:6, padding:"12px 16px"
                                    }}>
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
              <div style={S.fixedBlock}>
                <div style={S.fixedTitle}>Competition Staff — Present All Weekend</div>
                <div style={S.fixedGrid}>
                  <FixedGroup label="Drive Team"       names={fixedRoles.driveTeam}      accent="#e94560" />
                  <FixedGroup label="Pit Captain"      names={fixedRoles.pitCaptain}     accent="#ff6b35" />
                  <FixedGroup label="Lead Programmer"  names={fixedRoles.leadProgrammer} accent="#f4a261" />
                  <FixedGroup label="Scouting Lead"    names={fixedRoles.scoutingLead}   accent="#0096ff" />
                </div>
              </div>
            )}

            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20, flexWrap:"wrap", gap:12 }}>
              <h2 style={{ ...S.pt, margin:0 }}>Hourly Schedule</h2>
              <div style={{ display:"flex", gap:8 }}>
                {effectiveDays.map(day => (
                  <button key={day} style={{
                    ...S.bs, padding:"6px 16px", fontSize:12,
                    background: effectiveDay===day ? "#f4a261" : "transparent",
                    color:      effectiveDay===day ? "#0a0a0f"  : "#f4a261",
                  }} onClick={() => setSelectedDay(day)}>{day}</button>
                ))}
              </div>
            </div>

            {effectiveDay && schedule[effectiveDay] && (
              <div style={S.schedGrid}>
                {TIME_SLOTS.map(slot => {
                  const sr = schedule[effectiveDay][slot];
                  if (!sr) return null;
                  const anyone = sr.pitProg?.length || sr.pitMech?.length || sr.scouting?.length || sr.off?.length;
                  if (!anyone) return null;
                  const isPinned = (PINNED_PIT_SLOTS[effectiveDay] || []).includes(slot);
                  return (
                    <div key={slot} style={{ ...S.card, ...(isPinned ? { borderColor:"#f4a26144" } : {}) }}>
                      <div style={S.cardHeader}>
                        {slot}
                        {isPinned && <span style={{ fontSize:9, color:"#f4a261", letterSpacing:1, marginLeft:8 }}>PINNED</span>}
                      </div>
                      <SlotRow label="Pit Programmer" names={sr.pitProg}  accent="#f4a261" />
                      <SlotRow label="Pit Mechanic"   names={sr.pitMech}  accent="#ff6b35" />
                      <SlotRow label="Scouting"        names={sr.scouting} accent="#56cfe1" />
                      <SlotRow label="Off"             names={sr.off}      accent="#444"    />
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

function FixedGroup({ label, names, accent }) {
  if (!names?.length) return null;
  return (
    <div style={{ minWidth:140 }}>
      <div style={{ fontSize:10, letterSpacing:2, textTransform:"uppercase", color:accent, marginBottom:6 }}>{label}</div>
      {names.map(n => <div key={n} style={{ fontSize:13, color:"#ccc", marginBottom:3 }}>{n}</div>)}
    </div>
  );
}

function SlotRow({ label, names, accent }) {
  if (!names?.length) return null;
  return (
    <div style={{ marginBottom:10 }}>
      <div style={{ fontSize:10, letterSpacing:1, textTransform:"uppercase", color:accent, marginBottom:3 }}>{label}</div>
      <div style={{ fontSize:13, color:"#bbb", lineHeight:1.6 }}>{names.join(", ")}</div>
    </div>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const S = {
  root:      { minHeight:"100vh", background:"#0a0a0f", color:"#e8e8f0", fontFamily:"'Courier New','Consolas',monospace", position:"relative" },
  noise:     { position:"fixed", inset:0, pointerEvents:"none", zIndex:0, opacity:0.2,
               backgroundImage:`url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E")` },
  spinner:   { width:32, height:32, borderWidth:2, borderStyle:"solid", borderColor:"#1e1e2e", borderTopColor:"#f4a261", borderRadius:"50%", animation:"spin 0.8s linear infinite" },
  header:    { borderBottomWidth:1, borderBottomStyle:"solid", borderBottomColor:"#1e1e2e", background:"rgba(10,10,15,0.98)", backdropFilter:"blur(10px)", position:"sticky", top:0, zIndex:100 },
  hi:        { maxWidth:1100, margin:"0 auto", padding:"0 20px", display:"flex", alignItems:"center", justifyContent:"space-between", height:52 },
  logoText:  { fontSize:15, fontWeight:"bold", letterSpacing:4, color:"#f4a261" },
  nav:       { display:"flex", gap:4, flexWrap:"wrap" },
  nb:        { background:"none", borderWidth:1, borderStyle:"solid", borderColor:"transparent", color:"#555", padding:"5px 12px", cursor:"pointer", borderRadius:4, fontFamily:"inherit", fontSize:11, letterSpacing:1 },
  nba:       { borderColor:"#f4a261", color:"#f4a261" },
  main:      { maxWidth:1100, margin:"0 auto", padding:"32px 20px", position:"relative", zIndex:1 },
  ht:        { fontSize:"clamp(40px,8vw,80px)", margin:"0 0 4px", letterSpacing:10, color:"#f4a261", fontWeight:"bold", lineHeight:1 },
  panel:     { maxWidth:640, margin:"0 auto" },
  pt:        { fontSize:22, fontWeight:"bold", color:"#f4a261", letterSpacing:2, marginBottom:8 },
  pd:        { color:"#555", marginBottom:24, fontSize:13, lineHeight:1.8 },
  fg:        { marginBottom:20 },
  lbl:       { display:"block", fontSize:10, letterSpacing:2, color:"#555", marginBottom:8, textTransform:"uppercase" },
  input:     { width:"100%", background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:"#1e1e2e", color:"#e8e8f0", padding:"10px 14px", borderRadius:6, fontFamily:"inherit", fontSize:13, outline:"none", boxSizing:"border-box" },
  fu:        { display:"inline-flex", alignItems:"center", gap:8, background:"#0f0f16", borderWidth:1, borderStyle:"dashed", borderColor:"#2a2a3e", padding:"10px 18px", borderRadius:6, cursor:"pointer", fontSize:13, color:"#888" },
  ok:        { marginLeft:12, color:"#4ade80", fontSize:11 },
  ib:        { background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:"#1e1e2e", borderRadius:8, padding:"14px", marginBottom:20, fontSize:12, color:"#666" },
  sb:        { marginTop:16, background:"rgba(74,222,128,0.05)", borderWidth:1, borderStyle:"solid", borderColor:"rgba(74,222,128,0.2)", borderRadius:6, padding:"10px 14px", color:"#4ade80", fontSize:12 },
  eb:        { marginBottom:14, background:"rgba(233,69,96,0.06)", borderWidth:1, borderStyle:"solid", borderColor:"rgba(233,69,96,0.2)", borderRadius:6, padding:"10px 14px", color:"#e94560", fontSize:12 },
  bp:        { background:"#f4a261", color:"#0a0a0f", borderWidth:0, borderStyle:"solid", borderColor:"transparent", padding:"10px 24px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:"bold", letterSpacing:1 },
  bs:        { background:"transparent", color:"#f4a261", borderWidth:1, borderStyle:"solid", borderColor:"#f4a261", padding:"8px 18px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:12, letterSpacing:1 },
  dh:        { fontSize:10, letterSpacing:3, color:"#f4a261", textTransform:"uppercase", marginBottom:12, borderBottomWidth:1, borderBottomStyle:"solid", borderBottomColor:"#1a1a2a", paddingBottom:6 },
  fixedBlock:{ background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:"#1e1e2e", borderRadius:10, padding:"20px 24px", marginBottom:28 },
  fixedTitle:{ fontSize:10, letterSpacing:3, textTransform:"uppercase", color:"#555", marginBottom:16 },
  fixedGrid: { display:"flex", flexWrap:"wrap", gap:"20px 40px" },
  schedGrid: { display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(240px,1fr))", gap:12 },
  card:      { background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:"#1a1a2a", borderRadius:8, padding:"16px" },
  cardHeader:{ fontSize:18, fontWeight:"bold", color:"#f4a261", letterSpacing:2, marginBottom:12, borderBottomWidth:1, borderBottomStyle:"solid", borderBottomColor:"#1a1a2a", paddingBottom:8, display:"flex", alignItems:"baseline", gap:8 },
};

const _s = document.createElement("style");
_s.textContent = `@keyframes spin{to{transform:rotate(360deg)}}*{-webkit-tap-highlight-color:transparent;box-sizing:border-box}input,select,button{font-size:16px!important}`;
document.head.appendChild(_s);