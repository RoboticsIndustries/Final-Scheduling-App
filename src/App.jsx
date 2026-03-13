import { useState, useEffect, useCallback, useRef } from "react";

// ─── API ─────────────────────────────────────────────────────────────────────
async function loadFromBin() {
  const res = await fetch("/api/schedule");
  if (!res.ok) throw new Error("Failed to load schedule");
  return res.json();
}

async function saveToBin(data) {
  const res = await fetch("/api/schedule", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error("Failed to save schedule");
  return res.json();
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const SCOUTING_PER_SLOT = 6;
const TIME_SLOTS = ["8-9","9-10","10-11","11-12","12-1","1-2","2-3","3-4","4-5","5-6"];

// ─── PINNED CONSTRAINTS ───────────────────────────────────────────────────────
// No pinned constraints — pure round-robin rotation for all certified members

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function normalizeSlot(raw) {
  return raw.trim().replace(/\s*(AM|PM)/gi, "").trim();
}

function classifyMember(roleRaw, pitProgCert, pitMechCert) {
  const r = (roleRaw || "").trim().toLowerCase();
  let position = "Member";
  if      (r.includes("drive"))          position = "Drive Team";
  else if (r.includes("pit captain"))    position = "Pit Captain";
  else if (r.includes("scouting lead"))  position = "Scouting Lead";
  else if (r.includes("lead"))           position = "Lead Programmer";

  // Strictly col12 for pit prog, col13 for pit mech — no other columns
  const hasPitProg = (pitProgCert || "").toLowerCase() === "yes";
  const hasPitMech = (pitMechCert || "").toLowerCase() === "yes";

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
  const membersMap = {};

  for (const line of lines.slice(1)) {
    if (!line || line.length < 5) continue;
    const firstName = (line[1] || "").trim();
    const lastName  = (line[2] || "").trim();
    const name      = `${firstName} ${lastName}`.trim();
    if (!name) continue;
    const nl = name.toLowerCase();
    if (nl.includes("filler") || nl.match(/^first\s*\d*\s*last\s*\d*$/i) || firstName === "First") continue;

    const friArrival  = (line[4]  || "").trim();
    const satAllDay   = (line[5]  || "").trim().toLowerCase();
    const satHoursRaw = (line[6]  || "").trim();
    const sunAllDay   = (line[7]  || "").trim().toLowerCase();
    const sunHoursRaw = (line[8]  || "").trim();
    const roleRaw     = (line[10] || "").trim();
    const pitProgCert = (line[12] || "").trim();
    const pitMechCert = (line[13] || "").trim();

    const { position, hasPitProg, hasPitMech } = classifyMember(roleRaw, pitProgCert, pitMechCert);

    const friLower = friArrival.toLowerCase();
    let friSlots = [];
    if      (friLower.includes("4 pm") || friLower.includes("4pm")) friSlots = ["4-5","5-6"];
    else if (friLower.includes("5 pm") || friLower.includes("5pm")) friSlots = ["5-6"];
    else if (friLower.startsWith("yes"))                             friSlots = ["4-5","5-6"];

    const satSlots = satAllDay === "yes" ? [...TIME_SLOTS]
      : (satHoursRaw ? satHoursRaw.split(",").map(normalizeSlot).filter(s => TIME_SLOTS.includes(s)) : []);
    const sunSlots = sunAllDay === "yes" ? [...TIME_SLOTS]
      : (sunHoursRaw ? sunHoursRaw.split(",").map(normalizeSlot).filter(s => TIME_SLOTS.includes(s)) : []);

    const timingsByDay = {};
    if (friSlots.length) timingsByDay["Friday"]   = friSlots;
    if (satSlots.length) timingsByDay["Saturday"]  = satSlots;
    if (sunSlots.length) timingsByDay["Sunday"]    = sunSlots;

    // Last submission wins (most recent row overrides earlier duplicate)
    membersMap[name] = { position, hasPitProg, hasPitMech, timingsByDay };
  }

  const fixedRoles = { driveTeam: [], pitCaptain: [], leadProgrammer: [], scoutingLead: [] };
  const members = [];

  for (const [name, info] of Object.entries(membersMap)) {
    switch (info.position) {
      case "Drive Team":      fixedRoles.driveTeam.push(name);      break;
      case "Pit Captain":     fixedRoles.pitCaptain.push(name);     break;
      case "Scouting Lead":   fixedRoles.scoutingLead.push(name);   break;
      case "Lead Programmer": fixedRoles.leadProgrammer.push(name); break;
      default:
        members.push({ name, hasPitProg: info.hasPitProg, hasPitMech: info.hasPitMech,
          timingsByDay: info.timingsByDay, lastTask: null, pitCount: 0, scoutCount: 0 });
    }
  }

  const days = ["Saturday","Sunday"].filter(d => members.some(m => (m.timingsByDay[d] || []).length > 0));
  return { members, fixedRoles, days };
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
function generateSchedule(members, days) {
  const schedule = {};
  const byName = Object.fromEntries(members.map(m => [m.name, m]));

  for (const day of days) {
    schedule[day] = {};

    // Reset per-day state
    for (const m of members) { m.lastPitIdx = -99; m.lastScoutIdx = -99; }

    // Round-robin queues — all certified members available this day
    const dayMembers = members.filter(m => (m.timingsByDay[day] || []).length > 0);
    let progQueue = dayMembers.filter(m => m.hasPitProg).map(m => m.name);
    let mechQueue = dayMembers.filter(m => m.hasPitMech).map(m => m.name);

    for (let i = 0; i < TIME_SLOTS.length; i++) {
      const slot = TIME_SLOTS[i];
      const avail      = (name) => (byName[name]?.timingsByDay[day] || []).includes(slot);
      const restedPit  = (name) => (i - (byName[name]?.lastPitIdx ?? -99)) > 1;

      const used = new Set();
      let chosenProg = null, chosenMech = null;

      // ── 1 pit programmer (round-robin) ──
      for (const name of progQueue) {
        if (avail(name) && restedPit(name)) { chosenProg = name; break; }
      }
      if (chosenProg) {
        used.add(chosenProg);
        byName[chosenProg].lastPitIdx = i;
        progQueue = [...progQueue.filter(n => n !== chosenProg), chosenProg];
      }

      // ── 1 pit mechanic (round-robin) ──
      for (const name of mechQueue) {
        if (avail(name) && restedPit(name) && !used.has(name)) { chosenMech = name; break; }
      }
      if (chosenMech) {
        used.add(chosenMech);
        byName[chosenMech].lastPitIdx = i;
        mechQueue = [...mechQueue.filter(n => n !== chosenMech), chosenMech];
      }

      // ── 6 scouts, rotating (sort by who scouted least recently) ──
      const scoutPool = dayMembers
        .filter(m => avail(m.name) && !used.has(m.name))
        .sort((a, b) => (a.lastScoutIdx ?? -99) - (b.lastScoutIdx ?? -99));
      const scouting = [];
      for (const m of scoutPool) {
        if (scouting.length >= SCOUTING_PER_SLOT) break;
        scouting.push(m.name);
        used.add(m.name);
        m.lastScoutIdx = i;
      }

      // ── Everyone else is off ──
      const off = dayMembers.filter(m => avail(m.name) && !used.has(m.name)).map(m => m.name);

      schedule[day][slot] = {
        pitProg:  chosenProg ? [chosenProg] : [],
        pitMech:  chosenMech ? [chosenMech] : [],
        scouting,
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
  const startH = parseInt(slot.split("-")[0]);
  base.setHours((startH >= 1 && startH <= 7) ? startH + 12 : startH, 0, 0, 0);
  return base;
}

async function requestNotifPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

const ACCENT = { "Pit Programmer":"#f4a261", "Pit Mechanic":"#ff6b35", "Scouting":"#56cfe1", "Off":"#444" };

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView]               = useState("loading");
  const [csvText, setCsvText]         = useState("");
  const [csvLoaded, setCsvLoaded]     = useState(false);
  const [schedule, setSchedule]       = useState(null);
  const [fixedRoles, setFixedRoles]   = useState(null);
  const [days, setDays]               = useState([]);
  const [selectedDay, setSelectedDay] = useState(null);
  const [dayDates, setDayDates]       = useState({ Friday:"", Saturday:"", Sunday:"" });
  const [userName, setUserName]       = useState(() => localStorage.getItem("frc_user") || "");
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [parseError, setParseError]   = useState("");
  const [syncStatus, setSyncStatus]   = useState("idle");
  const notifTimers = useRef([]);

  // ── Load from JSONBin on mount ──
  useEffect(() => {
    loadFromBin()
      .then(record => {
        if (record && record.schedule) {
          if (record.fixedRoles) setFixedRoles(record.fixedRoles);
          if (record.dayDates)   setDayDates(prev => ({ ...prev, ...record.dayDates }));
          if (record.days && record.days.length > 0) {
            setDays(record.days);
            setSelectedDay(record.days[0]);
          }
          setSchedule(record.schedule);
          setView("full");
        } else {
          setView("landing");
        }
      })
      .catch(() => setView("landing"));
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
      setSyncStatus("saving");
      const { members, fixedRoles: fr, days: parsedDays } = parseCSV(csvText);
      if (!members.length) { setParseError("No schedulable members found."); setSyncStatus("idle"); return; }
      const sched = generateSchedule(members, parsedDays);
      await saveToBin({ schedule: sched, fixedRoles: fr, days: parsedDays, dayDates });
      setSchedule(sched);
      setFixedRoles(fr);
      setDays(parsedDays);
      setSelectedDay(parsedDays[0]);
      setSyncStatus("saved");
      setParseError("");
      setView("full");
      setTimeout(() => setSyncStatus("idle"), 3000);
    } catch(e) {
      setSyncStatus("error");
      setParseError("Error: " + e.message);
    }
  };

  const handleDayDate = async (day, date) => {
    const updated = { ...dayDates, [day]: date };
    setDayDates(updated);
    try { await saveToBin({ schedule, fixedRoles, days, dayDates: updated }); } catch(e) {}
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
        if      (r.pitProg?.includes(name))   role = "Pit Programmer";
        else if (r.pitMech?.includes(name))   role = "Pit Mechanic";
        else if (r.scouting?.includes(name))  role = "Scouting";
        else if (r.off?.includes(name))       role = "Off";
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

  const handlePrint = () => window.print();

  const effectiveDays = days.length > 0 ? days
    : schedule ? ["Friday","Saturday","Sunday"].filter(d => schedule[d] && Object.keys(schedule[d]).length > 0)
    : [];
  const effectiveDay  = (selectedDay && effectiveDays.includes(selectedDay)) ? selectedDay : (effectiveDays[0] || null);
  const hasSchedule   = !!schedule && effectiveDays.length > 0;

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

        {view === "admin" && (
          <div style={S.panel}>
            <h2 style={S.pt}>Admin</h2>
            <p style={S.pd}>Upload once. Everyone sees the schedule instantly.</p>
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
              onClick={handleGenerate} disabled={!csvLoaded}>
              {syncStatus==="saving" ? "Saving..." : syncStatus==="saved" ? "Saved" : "Generate & Save Schedule"}
            </button>
            {hasSchedule && (
              <>
                <div style={S.sb}>Schedule saved. All devices will load it automatically.</div>
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

        {view === "full" && hasSchedule && (
          <div>
            {fixedRoles && (
              <div style={S.fixedBlock} className="fixed-block">
                <div style={S.fixedTitle} className="fixed-title">Competition Staff — Present All Weekend</div>
                <div style={S.fixedGrid} className="fixed-grid">
                  <FixedGroup label="Drive Team"       names={fixedRoles.driveTeam}      accent="#e94560" />
                  <FixedGroup label="Pit Captain"      names={fixedRoles.pitCaptain}     accent="#ff6b35" />
                  <FixedGroup label="Lead Programmer"  names={fixedRoles.leadProgrammer} accent="#f4a261" />
                  <FixedGroup label="Scouting Lead"    names={fixedRoles.scoutingLead}   accent="#0096ff" />
                </div>
              </div>
            )}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12, flexWrap:"wrap", gap:12 }}>
              <h2 style={{ ...S.pt, margin:0 }}>Hourly Schedule</h2>
              <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
                {effectiveDays.map(day => (
                  <button key={day} style={{
                    ...S.bs, padding:"6px 16px", fontSize:12,
                    background: effectiveDay===day ? "#f4a261" : "transparent",
                    color:      effectiveDay===day ? "#0a0a0f"  : "#f4a261",
                  }} onClick={() => setSelectedDay(day)}>{day}</button>
                ))}
              </div>
            </div>
            <div style={{ marginBottom:20 }} className="no-print">
              <button style={{ ...S.bp, fontSize:12 }} onClick={handlePrint}>Save as PDF</button>
            </div>
            {effectiveDay && schedule[effectiveDay] && (
              <>
                <div className="print-title">PitSync — Competition Schedule</div>
                <div className="print-day">{effectiveDay}</div>
                <div style={S.schedGrid} className="sched-grid">
                {TIME_SLOTS.map(slot => {
                  const sr = schedule[effectiveDay][slot];
                  if (!sr) return null;
                  if (!sr.pitProg?.length && !sr.pitMech?.length && !sr.scouting?.length && !sr.off?.length) return null;
                  return (
                    <div key={slot} style={S.card} className="card">
                      <div style={S.cardHeader} className="card-header">{slot}</div>
                      <SlotRow label="Pit Programmer" names={sr.pitProg}  accent="#f4a261" />
                      <SlotRow label="Pit Mechanic"   names={sr.pitMech}  accent="#ff6b35" />
                      <SlotRow label="Scouting"        names={sr.scouting} accent="#56cfe1" />
                      <SlotRow label="Off"             names={sr.off}      accent="#444"    />
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

function FixedGroup({ label, names, accent }) {
  if (!names?.length) return null;
  return (
    <div style={{ minWidth:140 }}>
      <div className="fixed-label" style={{ fontSize:10, letterSpacing:2, textTransform:"uppercase", color:accent, marginBottom:6 }}>{label}</div>
      {names.map(n => <div key={n} className="fixed-name" style={{ fontSize:13, color:"#ccc", marginBottom:3 }}>{n}</div>)}
    </div>
  );
}

function SlotRow({ label, names, accent }) {
  if (!names?.length) return null;
  return (
    <div style={{ marginBottom:10 }}>
      <div className="slot-label" style={{ fontSize:10, letterSpacing:1, textTransform:"uppercase", color:accent, marginBottom:3 }}>{label}</div>
      <div className="slot-names" style={{ fontSize:13, color:"#bbb", lineHeight:1.6 }}>{names.join(", ")}</div>
    </div>
  );
}

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
  cardHeader:{ fontSize:18, fontWeight:"bold", color:"#f4a261", letterSpacing:2, marginBottom:12, borderBottomWidth:1, borderBottomStyle:"solid", borderBottomColor:"#1a1a2a", paddingBottom:8 },
  ib:        { background:"#0f0f16", borderWidth:1, borderStyle:"solid", borderColor:"#1e1e2e", borderRadius:8, padding:"14px", marginBottom:20, fontSize:12, color:"#666" },
};

const _s = document.createElement("style");
_s.textContent = `
  @keyframes spin{to{transform:rotate(360deg)}}
  *{-webkit-tap-highlight-color:transparent;box-sizing:border-box}
  input,select,button{font-size:16px!important}
  @media print {
    body { background: white !important; color: black !important; font-family: Arial, sans-serif !important; }
    header, nav, button, .no-print { display: none !important; }
    #root > div > div:first-child { display: none !important; }
    .fixed-block { border: 1px solid #ccc !important; border-radius: 4px; padding: 12px; margin-bottom: 16px; background: #f9f9f9 !important; }
    .fixed-title { color: #333 !important; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 10px; }
    .fixed-grid { display: flex; flex-wrap: wrap; gap: 20px 40px; }
    .sched-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .card { border: 1px solid #ddd !important; border-radius: 4px; padding: 10px; break-inside: avoid; background: white !important; }
    .card-header { font-size: 14px; font-weight: bold; color: #333 !important; border-bottom: 1px solid #eee; padding-bottom: 6px; margin-bottom: 8px; }
    .slot-label { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #666 !important; margin-bottom: 2px; }
    .slot-names { font-size: 11px; color: #333 !important; line-height: 1.5; }
    .fixed-label { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #666 !important; margin-bottom: 4px; }
    .fixed-name { font-size: 12px; color: #333 !important; margin-bottom: 2px; }
    .print-title { display: block !important; font-size: 20px; font-weight: bold; text-align: center; margin-bottom: 4px; color: black !important; }
    .print-day { display: block !important; font-size: 13px; text-align: center; margin-bottom: 16px; color: #555 !important; }
  }
  .print-title, .print-day { display: none; }
`;
document.head.appendChild(_s);