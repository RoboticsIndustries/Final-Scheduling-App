import { useState, useEffect, useCallback, useRef } from "react";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const PITS_LIMIT = 3;
const SCOUTING_LIMIT = 5;
const DRIVE_LIMIT = 2;
const MEMBER_PITS_MAX = 2;
const LEADS_PITS_MAX = 4;
const SCOUTING_MAX = 3;

const TIME_SLOTS = ["8-9","9-10","10-11","11-12","12-1","1-2","2-3","3-4","4-5","5-6"];

const POSITION_PRIORITY = { "Drive Team": 4, "Pit Captain": 3, "Scouting Lead": 3, "Lead": 2, "Member": 1 };

function normalizePosition(raw) {
  const p = raw.trim().toLowerCase();
  if (p.includes("drive")) return "Drive Team";
  if (p.includes("pit captain")) return "Pit Captain";
  if (p.includes("scouting lead") || p.includes("scouter")) return "Scouting Lead";
  if (p.includes("lead")) return "Lead";
  return "Member";
}

// Converts "Day 1 8:00 - 9:00" or "Day 1 8:00-9:00" → { day: "Day 1", slot: "8-9" }
function parseTimingString(raw) {
  const str = raw.trim().replace(/\s+/g, " ");
  const match = str.match(/^(Day\s*\d+)\s+(\d+)\s*(?::\s*\d+)?\s*[-–]\s*(\d+)/i);
  if (!match) return null;
  const day = match[1].replace(/\s+/g, " ").trim();
  const startH = parseInt(match[2]);
  const endH = parseInt(match[3]);
  const slot = `${startH}-${endH}`;
  if (!TIME_SLOTS.includes(slot)) return null;
  return { day, slot };
}

// ─── TEAM MEMBER CLASS ────────────────────────────────────────────────────────
class TeamMember {
  constructor(name, availableTimingsByDay, position) {
    this.name = name;
    this.availableTimingsByDay = availableTimingsByDay;
    this.position = position;
    this.timesUsed = 0;
    this.pitsCount = 0;
    this.scoutingCount = 0;
    this.lastTask = null;
  }
  isAvailable(day, slot) {
    return (this.availableTimingsByDay[day] || []).includes(slot);
  }
  canDo(role) {
    if (role === "Stands") return true;
    if (this.lastTask === role) return false;
    if (this.position === "Drive Team" && role !== "Drive Team") return false;
    return true;
  }
  assign(role) {
    this.timesUsed++;
    this.lastTask = role;
    if (role === "Pits" || role === "Pit Captain") this.pitsCount++;
    if (role === "Scouting" || role === "Scouting Lead") this.scoutingCount++;
  }
}

// ─── CSV PARSER ───────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const cols = [];
  let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  cols.push(cur.trim());
  return cols;
}

function parseCSV(text) {
  const lines = text.trim().split("\n").map(parseCSVLine);
  if (lines.length === 0) return { members: [], days: [] };

  let dataLines = lines;
  const firstRow = lines[0];
  const isHeader = firstRow.some(c => /name|position|timing|timestamp/i.test(c));

  let nameIdx = 1, posIdx = 3, timingIdx = 4;
  if (isHeader) {
    firstRow.forEach((col, i) => {
      const c = col.toLowerCase();
      if (c.includes("name")) nameIdx = i;
      if (c.includes("position") || c.includes("role")) posIdx = i;
      if (c.includes("timing") || c.includes("time") || c.includes("availab")) timingIdx = i;
    });
    dataLines = lines.slice(1);
  }

  const membersMap = {};
  const daysSet = new Set();

  for (const line of dataLines) {
    if (!line || line.length < 3) continue;
    const name = line[nameIdx]?.trim();
    const posRaw = line[posIdx]?.trim() || "Member";
    const timingsRaw = line[timingIdx] || "";
    if (!name) continue;

    const position = normalizePosition(posRaw);
    const timingEntries = timingsRaw.split(",").map(t => t.trim()).filter(Boolean);
    const timingsByDay = {};

    for (const entry of timingEntries) {
      const parsed = parseTimingString(entry);
      if (!parsed) continue;
      const { day, slot } = parsed;
      daysSet.add(day);
      if (!timingsByDay[day]) timingsByDay[day] = [];
      if (!timingsByDay[day].includes(slot)) timingsByDay[day].push(slot);
    }

    if (membersMap[name]) {
      const ex = membersMap[name];
      for (const [day, slots] of Object.entries(timingsByDay)) {
        if (!ex.timingsByDay[day]) ex.timingsByDay[day] = [];
        for (const sl of slots) if (!ex.timingsByDay[day].includes(sl)) ex.timingsByDay[day].push(sl);
      }
      if ((POSITION_PRIORITY[position] || 0) > (POSITION_PRIORITY[ex.position] || 0)) ex.position = position;
    } else {
      membersMap[name] = { position, timingsByDay };
    }
  }

  const members = Object.entries(membersMap).map(([name, info]) =>
    new TeamMember(name, info.timingsByDay, info.position)
  );

  const days = [...daysSet].sort((a, b) => {
    const na = parseInt(a.match(/\d+/)?.[0] || 0);
    const nb = parseInt(b.match(/\d+/)?.[0] || 0);
    return na - nb;
  });

  return { members, days };
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
function generateSchedule(members, days) {
  const schedule = {};
  for (const day of days) {
    schedule[day] = {};
    for (const m of members) m.lastTask = null;

    for (const slot of TIME_SLOTS) {
      const available = members.filter(m => m.isAvailable(day, slot));
      let remaining = [...available];
      const pits = [], scouting = [], driveTeam = [], stands = [];
      let pitCaptain = null, scoutingLead = null;

      const pick = (m, role) => {
        if (role === "Drive Team") driveTeam.push(m.name);
        m.assign(role);
        remaining = remaining.filter(r => r.name !== m.name);
      };

      for (const m of remaining.filter(m => m.position === "Drive Team" && m.canDo("Drive Team")).slice(0, DRIVE_LIMIT)) pick(m, "Drive Team");
      const pcm = remaining.find(m => m.position === "Pit Captain" && m.canDo("Pit Captain"));
      if (pcm) { pitCaptain = pcm.name; pick(pcm, "Pit Captain"); }
      const slm = remaining.find(m => m.position === "Scouting Lead" && m.canDo("Scouting Lead"));
      if (slm) { scoutingLead = slm.name; pick(slm, "Scouting Lead"); }

      for (const m of remaining.filter(m => m.position === "Lead" && m.canDo("Pits") && m.pitsCount < LEADS_PITS_MAX)) {
        if (pits.length >= PITS_LIMIT) break;
        pits.push(m.name); pick(m, "Pits");
      }
      for (const m of remaining.filter(m => m.position === "Member" && m.canDo("Pits") && m.pitsCount < MEMBER_PITS_MAX)) {
        if (pits.length >= PITS_LIMIT) break;
        pits.push(m.name); pick(m, "Pits");
      }
      for (const m of remaining.filter(m => m.canDo("Scouting") && m.scoutingCount < SCOUTING_MAX)) {
        if (scouting.length >= SCOUTING_LIMIT) break;
        scouting.push(m.name); pick(m, "Scouting");
      }
      for (const m of remaining) { stands.push(m.name); m.assign("Stands"); }

      schedule[day][slot] = { pits, scouting, driveTeam, stands, pitCaptain, scoutingLead };
    }
  }
  return schedule;
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────
function parseSlotTime(day, slot, dayDates) {
  const dateStr = dayDates[day];
  if (!dateStr) return null;
  const base = new Date(dateStr);
  if (isNaN(base)) return null;
  const startH = parseInt(slot.split("-")[0]);
  const hour = (startH >= 1 && startH <= 7) ? startH + 12 : startH;
  base.setHours(hour, 0, 0, 0);
  return base;
}

async function requestNotifPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

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
  const [schedule, setSchedule] = useState(null);
  const [days, setDays] = useState([]);
  const [selectedDay, setSelectedDay] = useState(null);
  const [dayDates, setDayDates] = useState({});
  const [userName, setUserName] = useState(() => localStorage.getItem("frc_user") || "");
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [parseError, setParseError] = useState("");
  const [csvLoaded, setCsvLoaded] = useState(false);
  const notifTimers = useRef([]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("frc_sched_v3");
      const savedDays = localStorage.getItem("frc_days_v3");
      const savedDates = localStorage.getItem("frc_dates_v3");
      if (saved) setSchedule(JSON.parse(saved));
      if (savedDays) { const d = JSON.parse(savedDays); setDays(d); setSelectedDay(d[0]); }
      if (savedDates) setDayDates(JSON.parse(savedDates));
    } catch(e) {}
  }, []);

  const handleCSVUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setCsvText(ev.target.result); setCsvLoaded(true); setParseError(""); };
    reader.readAsText(file);
  };

  const handleGenerate = () => {
    if (!csvText) return;
    try {
      const { members, days: parsedDays } = parseCSV(csvText);
      if (members.length === 0) { setParseError("No members parsed. Check CSV format."); return; }
      const sched = generateSchedule(members, parsedDays);
      setSchedule(sched);
      setDays(parsedDays);
      setSelectedDay(parsedDays[0] || null);
      localStorage.setItem("frc_sched_v3", JSON.stringify(sched));
      localStorage.setItem("frc_days_v3", JSON.stringify(parsedDays));
      setParseError("");
      setView("full");
    } catch(e) {
      setParseError("Parse error: " + e.message);
    }
  };

  const handleDayDate = (day, date) => {
    const updated = { ...dayDates, [day]: date };
    setDayDates(updated);
    localStorage.setItem("frc_dates_v3", JSON.stringify(updated));
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
    const slots = [];
    for (const [day, ds] of Object.entries(schedule)) {
      for (const [slot, r] of Object.entries(ds)) {
        let role = null;
        if (r.driveTeam?.includes(name)) role = "Drive Team";
        else if (r.pitCaptain === name) role = "Pit Captain";
        else if (r.scoutingLead === name) role = "Scouting Lead";
        else if (r.pits?.includes(name)) role = "Pits";
        else if (r.scouting?.includes(name)) role = "Scouting";
        else if (r.stands?.includes(name)) role = "Stands";
        if (role) slots.push({ day, slot, role });
      }
    }
    return slots;
  }, [schedule]);

  const setupNotifs = useCallback(async (name) => {
    const granted = await requestNotifPermission();
    if (!granted) { alert("Notification permission denied. Please allow in browser settings."); return; }
    setNotifEnabled(true);
    notifTimers.current.forEach(clearTimeout);
    notifTimers.current = [];
    for (const { day, slot, role } of getPersonalSlots(name)) {
      const t = parseSlotTime(day, slot, dayDates);
      if (!t) continue;
      const delay = t.getTime() - 10 * 60 * 1000 - Date.now();
      if (delay < 0) continue;
      notifTimers.current.push(setTimeout(() => {
        new Notification("⚙️ PitSync Reminder", { body: `You're on ${role} at ${slot} (${day}). Get ready!` });
      }, delay));
    }
  }, [getPersonalSlots, dayDates]);

  const hasSchedule = !!schedule;

  return (
    <div style={c.root}>
      <div style={c.noise} />
      <header style={c.header}>
        <div style={c.hi}>
          <div style={c.logo}><span style={c.logoIcon}>⚙</span><span style={c.logoText}>PitSync</span></div>
          <nav style={c.nav}>
            {[["landing","Home"],["admin","Admin"],...(hasSchedule?[["personal","My Schedule"],["full","Full Schedule"]]:[])].map(([v,label])=>(
              <button key={v} style={{...c.nb,...(view===v?c.nba:{})}} onClick={()=>setView(v)}>{label}</button>
            ))}
          </nav>
        </div>
      </header>

      <main style={c.main}>

        {view==="landing" && (
          <div style={c.landing}>
            <div style={c.glow}/>
            <h1 style={c.ht}>PitSync</h1>
            <p style={c.hs}>FRC Competition Scheduler</p>
            <p style={c.hd}>Upload your Google Form CSV, generate a smart role-constrained schedule, and get push notifications before each of your slots.</p>
            <div style={c.hb}>
              <button style={c.bp} onClick={()=>setView("admin")}>{hasSchedule?"Re-upload CSV →":"Upload CSV →"}</button>
              {hasSchedule && <button style={c.bs} onClick={()=>setView("personal")}>My Schedule</button>}
              {hasSchedule && <button style={c.bs} onClick={()=>setView("full")}>Full Schedule</button>}
            </div>
            <div style={c.fr}>
              {[["🔧","Pit Captain & Scouting Lead roles"],["🔔","Push notifications 10 min before"],["📅","Multi-day support"],["🚫","No back-to-back same roles"]].map(([ic,lb])=>(
                <div key={lb} style={c.fc}><span style={c.fi}>{ic}</span><span style={c.fl}>{lb}</span></div>
              ))}
            </div>
          </div>
        )}

        {view==="admin" && (
          <div style={c.panel}>
            <h2 style={c.pt}>Admin — Upload Schedule</h2>
            <p style={c.pd}>Upload your Google Form CSV export. The parser is built to match your form's exact format.</p>

            <div style={c.fg}>
              <label style={c.lbl}>CSV File</label>
              <label style={c.fu}>
                <span>📂 Choose CSV file</span>
                <input type="file" accept=".csv" onChange={handleCSVUpload} style={{display:"none"}}/>
              </label>
              {csvLoaded && <span style={c.fr2}>✓ File loaded</span>}
            </div>

            <div style={c.ib}>
              <strong style={{color:"#f4a261"}}>Your form columns (auto-detected):</strong>
              <code style={c.code}>Timestamp | Name | Years | Position | Timings</code>
              <p style={{margin:"8px 0 0",fontSize:"12px",color:"#777",lineHeight:1.7}}>
                Timing format: <em>"Day 1 8:00 - 9:00, Day 1 9:00 - 10:00"</em><br/>
                <em>Programming Crew, Mechanical Crew, CAD Team</em> → treated as <strong style={{color:"#ccc"}}>Member</strong><br/>
                Special positions: <em>Lead, Drive Team, Pit Captain, Scouting Lead/Scouter</em>
              </p>
            </div>

            {parseError && <div style={c.eb}>{parseError}</div>}

            <button style={{...c.bp, opacity:csvLoaded?1:0.4, cursor:csvLoaded?"pointer":"not-allowed"}}
              onClick={handleGenerate} disabled={!csvLoaded}>
              Generate Schedule
            </button>

            {hasSchedule && (
              <>
                <div style={c.sb}>✓ Schedule generated! Set competition dates below for push notifications.</div>
                <div style={{marginTop:28}}>
                  <p style={{...c.lbl,marginBottom:14}}>SET DATES FOR NOTIFICATIONS</p>
                  {days.map(day=>(
                    <div key={day} style={{display:"flex",alignItems:"center",gap:16,marginBottom:14}}>
                      <span style={{...c.lbl,margin:0,minWidth:50}}>{day}</span>
                      <input type="date" value={dayDates[day]||""} onChange={e=>handleDayDate(day,e.target.value)} style={{...c.input,flex:1}}/>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {view==="personal" && (
          <div style={c.panel}>
            <h2 style={c.pt}>My Schedule</h2>
            {!hasSchedule
              ? <p style={c.pd}>No schedule yet. Ask your admin to upload the CSV first.</p>
              : <>
                <div style={c.fg}>
                  <label style={c.lbl}>Your Name</label>
                  <select value={userName} onChange={e=>{setUserName(e.target.value);localStorage.setItem("frc_user",e.target.value);}} style={c.input}>
                    <option value="">— Select your name —</option>
                    {allNames.map(n=><option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                {userName && (
                  <>
                    <button style={{...c.bs,marginBottom:28}} onClick={()=>setupNotifs(userName)}>
                      {notifEnabled?"✓ Notifications Active":"🔔 Enable Notifications"}
                    </button>
                    {days.map(day=>{
                      const mySlots = getPersonalSlots(userName).filter(x=>x.day===day);
                      return (
                        <div key={day} style={{marginBottom:32}}>
                          <div style={c.dh}>{day}</div>
                          {mySlots.length===0
                            ? <p style={{color:"#444",fontSize:13}}>No assignments this day.</p>
                            : <div style={{display:"flex",flexDirection:"column",gap:10}}>
                                {mySlots.map(({slot,role})=>{
                                  const rs=ROLE_STYLES[role]||ROLE_STYLES["Stands"];
                                  return (
                                    <div key={slot} style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"#0f0f16",border:`1px solid ${rs.accent}`,borderRadius:8,padding:"14px 18px"}}>
                                      <span style={{fontSize:18,fontWeight:"bold",letterSpacing:2,color:rs.accent}}>{slot}</span>
                                      <span style={{background:rs.accent,color:"#0a0a0f",padding:"4px 14px",borderRadius:20,fontSize:12,fontWeight:"bold"}}>{rs.label}</span>
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
            }
          </div>
        )}

        {view==="full" && hasSchedule && (
          <div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24,flexWrap:"wrap",gap:12}}>
              <h2 style={{...c.pt,margin:0}}>Full Schedule</h2>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {days.map(day=>(
                  <button key={day} style={{...c.bs,padding:"6px 16px",fontSize:12,background:selectedDay===day?"#f4a261":"none",color:selectedDay===day?"#0a0a0f":"#f4a261"}}
                    onClick={()=>setSelectedDay(day)}>{day}</button>
                ))}
              </div>
            </div>
            {selectedDay && (
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(260px, 1fr))",gap:14}}>
                {TIME_SLOTS.map(slot=>{
                  const sr=schedule[selectedDay]?.[slot];
                  if(!sr) return null;
                  const anyone=sr.driveTeam?.length||sr.pitCaptain||sr.pits?.length||sr.scoutingLead||sr.scouting?.length||sr.stands?.length;
                  if(!anyone) return null;
                  return (
                    <div key={slot} style={{background:"#0f0f16",border:"1px solid #1a1a2a",borderRadius:10,padding:"18px"}}>
                      <div style={{fontSize:20,fontWeight:"bold",color:"#f4a261",letterSpacing:3,marginBottom:12,borderBottom:"1px solid #1a1a2a",paddingBottom:8}}>{slot}</div>
                      <RR label="Drive Team" names={sr.driveTeam} accent="#e94560"/>
                      <RR label="Pit Captain ★" names={sr.pitCaptain?[sr.pitCaptain]:[]} accent="#ff6b35"/>
                      <RR label="Pits" names={sr.pits} accent="#f4a261"/>
                      <RR label="Scouting Lead ★" names={sr.scoutingLead?[sr.scoutingLead]:[]} accent="#0096ff"/>
                      <RR label="Scouting" names={sr.scouting} accent="#56cfe1"/>
                      <RR label="Stands" names={sr.stands} accent="#8338ec"/>
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
  if (!names || names.length === 0) return null;
  return (
    <div style={{marginBottom:8}}>
      <span style={{fontSize:10,letterSpacing:1,textTransform:"uppercase",display:"block",marginBottom:2,color:accent}}>{label}</span>
      <span style={{fontSize:13,color:"#bbb"}}>{names.join(", ")}</span>
    </div>
  );
}

const c = {
  root:{minHeight:"100vh",background:"#0a0a0f",color:"#e8e8f0",fontFamily:"'Courier New','Consolas',monospace",position:"relative"},
  noise:{position:"fixed",inset:0,pointerEvents:"none",zIndex:0,opacity:0.25,backgroundImage:`url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E")`},
  header:{borderBottom:"1px solid #1e1e2e",background:"rgba(10,10,15,0.97)",backdropFilter:"blur(10px)",position:"sticky",top:0,zIndex:100},
  hi:{maxWidth:1100,margin:"0 auto",padding:"0 24px",display:"flex",alignItems:"center",justifyContent:"space-between",height:56},
  logo:{display:"flex",alignItems:"center",gap:10},
  logoIcon:{fontSize:18,color:"#f4a261"},
  logoText:{fontSize:18,fontWeight:"bold",letterSpacing:3,color:"#f4a261"},
  nav:{display:"flex",gap:4,flexWrap:"wrap"},
  nb:{background:"none",border:"1px solid transparent",color:"#555",padding:"5px 12px",cursor:"pointer",borderRadius:4,fontFamily:"inherit",fontSize:11,letterSpacing:1},
  nba:{borderColor:"#f4a261",color:"#f4a261"},
  main:{maxWidth:1100,margin:"0 auto",padding:"40px 24px",position:"relative",zIndex:1},
  landing:{textAlign:"center",padding:"60px 0",position:"relative"},
  glow:{position:"absolute",top:"-60px",left:"50%",transform:"translateX(-50%)",width:700,height:350,borderRadius:"50%",background:"radial-gradient(ellipse, rgba(244,162,97,0.07) 0%, transparent 70%)",pointerEvents:"none"},
  ht:{fontSize:"clamp(52px,10vw,104px)",margin:"0 0 4px",letterSpacing:10,color:"#f4a261",fontWeight:"bold",lineHeight:1},
  hs:{fontSize:14,color:"#444",letterSpacing:5,margin:"0 0 18px",textTransform:"uppercase"},
  hd:{fontSize:13,color:"#777",maxWidth:460,margin:"0 auto 38px",lineHeight:1.8},
  hb:{display:"flex",gap:12,justifyContent:"center",marginBottom:52,flexWrap:"wrap"},
  fr:{display:"flex",flexWrap:"wrap",gap:12,justifyContent:"center"},
  fc:{background:"#0f0f16",border:"1px solid #1a1a2a",borderRadius:8,padding:"12px 16px",display:"flex",alignItems:"center",gap:10,minWidth:190},
  fi:{fontSize:16},
  fl:{fontSize:11,color:"#777"},
  panel:{maxWidth:660,margin:"0 auto"},
  pt:{fontSize:24,fontWeight:"bold",color:"#f4a261",letterSpacing:2,marginBottom:8},
  pd:{color:"#666",marginBottom:28,fontSize:13,lineHeight:1.8},
  fg:{marginBottom:20},
  lbl:{display:"block",fontSize:10,letterSpacing:2,color:"#555",marginBottom:8,textTransform:"uppercase"},
  input:{width:"100%",background:"#0f0f16",border:"1px solid #1e1e2e",color:"#e8e8f0",padding:"10px 14px",borderRadius:6,fontFamily:"inherit",fontSize:13,outline:"none",boxSizing:"border-box"},
  fu:{display:"inline-flex",alignItems:"center",gap:8,background:"#0f0f16",border:"1px dashed #2a2a3e",padding:"10px 18px",borderRadius:6,cursor:"pointer",fontSize:13,color:"#999"},
  fr2:{marginLeft:12,color:"#4ade80",fontSize:11},
  ib:{background:"#0f0f16",border:"1px solid #1e1e2e",borderRadius:8,padding:"14px",marginBottom:22,fontSize:12,color:"#777"},
  code:{display:"block",background:"#080810",border:"1px solid #1a1a2a",padding:"7px 12px",borderRadius:4,color:"#56cfe1",fontFamily:"inherit",margin:"7px 0",fontSize:11},
  sb:{marginTop:18,background:"rgba(74,222,128,0.06)",border:"1px solid rgba(74,222,128,0.2)",borderRadius:8,padding:"11px 14px",color:"#4ade80",fontSize:12},
  eb:{marginBottom:14,background:"rgba(233,69,96,0.07)",border:"1px solid rgba(233,69,96,0.25)",borderRadius:8,padding:"11px 14px",color:"#e94560",fontSize:12},
  bp:{background:"#f4a261",color:"#0a0a0f",border:"none",padding:"10px 24px",borderRadius:6,cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:"bold",letterSpacing:1},
  bs:{background:"none",color:"#f4a261",border:"1px solid #f4a261",padding:"8px 20px",borderRadius:6,cursor:"pointer",fontFamily:"inherit",fontSize:12,letterSpacing:1},
  dh:{fontSize:11,letterSpacing:3,color:"#f4a261",textTransform:"uppercase",marginBottom:12,borderBottom:"1px solid #1a1a2a",paddingBottom:7},
};