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

// ─── TEAM MEMBER CLASS ────────────────────────────────────────────────────────
class TeamMember {
  constructor(name, availableTimings, position) {
    this.name = name;
    this.availableTimings = availableTimings.map(t => t.trim());
    this.position = position.trim();
    this.timesUsed = 0;
    this.pitsCount = 0;
    this.scoutingCount = 0;
    this.lastTask = null;
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
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const membersMap = {};
  let competitionDate = null;

  const isHeader = (row) => row.some(c => /name|position|timing/i.test(c));

  let dataLines = lines.map(l => {
    // handle quoted CSV fields
    const cols = [];
    let cur = "", inQ = false;
    for (let ch of l) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    cols.push(cur.trim());
    return cols;
  });

  if (dataLines.length > 0 && isHeader(dataLines[0])) {
    // check if there's a date column in header
    const header = dataLines[0];
    const dateIdx = header.findIndex(h => /date|competition/i.test(h));
    if (dateIdx >= 0 && dataLines[1]) {
      competitionDate = dataLines[1][dateIdx];
    }
    dataLines = dataLines.slice(1);
  }

  for (const line of dataLines) {
    if (!line || line.length < 4) continue;
    const name = line[1]?.trim();
    const position = (line[2]?.trim() || "Member");
    const timingsRaw = line[3] || "";
    const timings = timingsRaw.split(",").map(t => t.trim()).filter(Boolean);

    if (!name) continue;

    if (membersMap[name]) {
      const ex = membersMap[name];
      for (const t of timings) if (!ex.timings.includes(t)) ex.timings.push(t);
      if ((POSITION_PRIORITY[position] || 0) > (POSITION_PRIORITY[ex.position] || 0)) {
        ex.position = position;
      }
    } else {
      membersMap[name] = { position, timings };
    }
  }

  const members = Object.entries(membersMap).map(([name, info]) =>
    new TeamMember(name, info.timings, info.position)
  );

  return { members, competitionDate };
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
function generateSchedule(members) {
  const schedule = {};

  for (const slot of TIME_SLOTS) {
    const available = members.filter(m => m.availableTimings.includes(slot));
    let remaining = [...available];

    const pits = [], scouting = [], driveTeam = [], stands = [];
    let pitCaptain = null, scoutingLead = null;

    // 1) Drive Team
    const driveCandidates = remaining.filter(m => m.position === "Drive Team" && m.canDo("Drive Team"));
    for (const m of driveCandidates.slice(0, DRIVE_LIMIT)) {
      driveTeam.push(m.name); m.assign("Drive Team");
      remaining = remaining.filter(r => r.name !== m.name);
    }

    // 2) Pit Captain (fixed role, assign to pits slot with special label)
    const pitCaptainMember = remaining.find(m => m.position === "Pit Captain" && m.canDo("Pit Captain"));
    if (pitCaptainMember) {
      pitCaptain = pitCaptainMember.name;
      pitCaptainMember.assign("Pit Captain");
      remaining = remaining.filter(r => r.name !== pitCaptainMember.name);
    }

    // 3) Scouting Lead
    const scoutLeadMember = remaining.find(m => m.position === "Scouting Lead" && m.canDo("Scouting Lead"));
    if (scoutLeadMember) {
      scoutingLead = scoutLeadMember.name;
      scoutLeadMember.assign("Scouting Lead");
      remaining = remaining.filter(r => r.name !== scoutLeadMember.name);
    }

    // 4) Pits: Leads first
    const leadPits = remaining.filter(m => m.position === "Lead" && m.canDo("Pits") && m.pitsCount < LEADS_PITS_MAX);
    for (const m of leadPits) {
      if (pits.length >= PITS_LIMIT) break;
      pits.push(m.name); m.assign("Pits");
      remaining = remaining.filter(r => r.name !== m.name);
    }
    // Members for pits
    const memberPits = remaining.filter(m => m.position === "Member" && m.canDo("Pits") && m.pitsCount < MEMBER_PITS_MAX);
    for (const m of memberPits) {
      if (pits.length >= PITS_LIMIT) break;
      pits.push(m.name); m.assign("Pits");
      remaining = remaining.filter(r => r.name !== m.name);
    }

    // 5) Scouting
    const scoutCandidates = remaining.filter(m => m.canDo("Scouting") && m.scoutingCount < SCOUTING_MAX);
    for (const m of scoutCandidates) {
      if (scouting.length >= SCOUTING_LIMIT) break;
      scouting.push(m.name); m.assign("Scouting");
      remaining = remaining.filter(r => r.name !== m.name);
    }

    // 6) Stands
    for (const m of remaining) {
      stands.push(m.name); m.assign("Stands");
    }

    schedule[slot] = { pits, scouting, driveTeam, stands, pitCaptain, scoutingLead };
  }

  return schedule;
}

// ─── NOTIFICATION HELPERS ─────────────────────────────────────────────────────
function parseSlotTime(slot, competitionDate) {
  if (!competitionDate) return null;
  const base = new Date(competitionDate);
  if (isNaN(base)) return null;
  const startHour = parseInt(slot.split("-")[0]);
  const hour = startHour < 8 ? startHour + 12 : startHour; // handle PM (1-6 = 13-18)
  base.setHours(hour, 0, 0, 0);
  return base;
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  const result = await Notification.requestPermission();
  return result === "granted";
}

function scheduleNotification(title, body, fireAt) {
  const now = Date.now();
  const delay = fireAt - now;
  if (delay < 0) return null;
  return setTimeout(() => {
    if (Notification.permission === "granted") {
      new Notification(title, { body, icon: "⚙️" });
    }
  }, delay);
}

// ─── ROLE COLOR MAP ───────────────────────────────────────────────────────────
const ROLE_STYLES = {
  "Drive Team":   { bg: "#1a1a2e", accent: "#e94560", label: "Drive Team" },
  "Pits":         { bg: "#0f2027", accent: "#f4a261", label: "Pits" },
  "Pit Captain":  { bg: "#0f2027", accent: "#ff6b35", label: "Pit Captain ★" },
  "Scouting":     { bg: "#1b2838", accent: "#56cfe1", label: "Scouting" },
  "Scouting Lead":{ bg: "#1b2838", accent: "#0096ff", label: "Scouting Lead ★" },
  "Stands":       { bg: "#1a1a2e", accent: "#8338ec", label: "Stands" },
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState("landing"); // landing | admin | personal
  const [csvText, setCsvText] = useState("");
  const [schedule, setSchedule] = useState(null);
  const [competitionDate, setCompetitionDate] = useState("");
  const [userName, setUserName] = useState(() => localStorage.getItem("frc_user") || "");
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [adminKey] = useState("frc_admin_schedule");
  const notifTimers = useRef([]);

  // Load saved schedule from storage
  useEffect(() => {
    const saved = localStorage.getItem("frc_schedule");
    const savedDate = localStorage.getItem("frc_comp_date");
    if (saved) { setSchedule(JSON.parse(saved)); }
    if (savedDate) setCompetitionDate(savedDate);
  }, []);

  // Handle CSV upload
  const handleCSVUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setCsvText(ev.target.result);
    reader.readAsText(file);
  };

  const handleGenerateSchedule = () => {
    if (!csvText) return;
    const { members, competitionDate: csvDate } = parseCSV(csvText);
    const sched = generateSchedule(members);
    setSchedule(sched);
    localStorage.setItem("frc_schedule", JSON.stringify(sched));
    const finalDate = competitionDate || csvDate || "";
    if (finalDate) {
      setCompetitionDate(finalDate);
      localStorage.setItem("frc_comp_date", finalDate);
    }
  };

  // Get personal schedule for a user
  const getPersonalSlots = useCallback((name) => {
    if (!schedule || !name) return [];
    const slots = [];
    for (const [slot, roles] of Object.entries(schedule)) {
      let role = null;
      if (roles.driveTeam?.includes(name)) role = "Drive Team";
      else if (roles.pitCaptain === name) role = "Pit Captain";
      else if (roles.scoutingLead === name) role = "Scouting Lead";
      else if (roles.pits?.includes(name)) role = "Pits";
      else if (roles.scouting?.includes(name)) role = "Scouting";
      else if (roles.stands?.includes(name)) role = "Stands";
      if (role) slots.push({ slot, role });
    }
    return slots;
  }, [schedule]);

  // Setup notifications
  const setupNotifications = useCallback(async (name) => {
    const granted = await requestNotificationPermission();
    if (!granted) return;
    setNotifEnabled(true);
    // clear old timers
    notifTimers.current.forEach(clearTimeout);
    notifTimers.current = [];

    const personalSlots = getPersonalSlots(name);
    for (const { slot, role } of personalSlots) {
      const slotTime = parseSlotTime(slot, competitionDate);
      if (!slotTime) continue;
      // notify 10 min before
      const fireAt = slotTime.getTime() - 10 * 60 * 1000;
      const t = scheduleNotification(
        `⚙️ FRC Schedule Reminder`,
        `You're on ${role} at ${slot}. Get ready!`,
        fireAt
      );
      if (t) notifTimers.current.push(t);
    }
  }, [getPersonalSlots, competitionDate]);

  const handleUserLogin = (name) => {
    setUserName(name);
    localStorage.setItem("frc_user", name);
    setView("personal");
  };

  const allNames = schedule
    ? [...new Set(Object.values(schedule).flatMap(s =>
        [...(s.driveTeam||[]), ...(s.pits||[]), ...(s.scouting||[]), ...(s.stands||[]),
         s.pitCaptain, s.scoutingLead].filter(Boolean)
      ))]
    : [];

  return (
    <div style={styles.root}>
      <div style={styles.noise} />

      {/* HEADER */}
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.logo}>
            <span style={styles.logoIcon}>⚙</span>
            <span style={styles.logoText}>PitSync</span>
          </div>
          <nav style={styles.nav}>
            <button style={{...styles.navBtn, ...(view==="landing"?styles.navBtnActive:{})}} onClick={()=>setView("landing")}>Home</button>
            <button style={{...styles.navBtn, ...(view==="admin"?styles.navBtnActive:{})}} onClick={()=>setView("admin")}>Admin</button>
            {schedule && <button style={{...styles.navBtn, ...(view==="personal"?styles.navBtnActive:{})}} onClick={()=>setView("personal")}>My Schedule</button>}
            {schedule && <button style={{...styles.navBtn, ...(view==="full"?styles.navBtnActive:{})}} onClick={()=>setView("full")}>Full Schedule</button>}
          </nav>
        </div>
      </header>

      <main style={styles.main}>
        {/* LANDING */}
        {view === "landing" && (
          <div style={styles.landing}>
            <div style={styles.heroGlow} />
            <h1 style={styles.heroTitle}>PitSync</h1>
            <p style={styles.heroSub}>FRC Competition Scheduler</p>
            <p style={styles.heroDesc}>Upload your team's availability CSV, generate a smart schedule with role constraints, and get notified before your next assignment.</p>
            <div style={styles.heroButtons}>
              {!schedule && <button style={styles.btnPrimary} onClick={()=>setView("admin")}>Upload CSV →</button>}
              {schedule && <button style={styles.btnPrimary} onClick={()=>setView("personal")}>View My Schedule →</button>}
              {schedule && <button style={styles.btnSecondary} onClick={()=>setView("full")}>Full Schedule</button>}
            </div>
            <div style={styles.featureRow}>
              {[
                {icon:"🔧", label:"Pit Captain & Scouting Lead roles"},
                {icon:"🔔", label:"Push notifications before your slot"},
                {icon:"🚫", label:"No back-to-back same roles"},
                {icon:"📋", label:"CSV from Google Forms"},
              ].map(f => (
                <div key={f.label} style={styles.featureCard}>
                  <span style={styles.featureIcon}>{f.icon}</span>
                  <span style={styles.featureLabel}>{f.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ADMIN */}
        {view === "admin" && (
          <div style={styles.panel}>
            <h2 style={styles.panelTitle}>Admin — Upload Schedule</h2>
            <p style={styles.panelDesc}>Upload your Google Form CSV export. The app will generate the full schedule and save it for everyone.</p>

            <div style={styles.formGroup}>
              <label style={styles.label}>CSV File (from Google Forms)</label>
              <label style={styles.fileUpload}>
                <span>Choose CSV file</span>
                <input type="file" accept=".csv" onChange={handleCSVUpload} style={{display:"none"}} />
              </label>
              {csvText && <span style={styles.fileReady}>✓ File loaded</span>}
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Competition Date (for notifications)</label>
              <input
                type="date"
                value={competitionDate}
                onChange={e => setCompetitionDate(e.target.value)}
                style={styles.input}
              />
            </div>

            <div style={styles.infoBox}>
              <strong style={{color:"#f4a261"}}>Expected CSV columns:</strong>
              <code style={styles.code}>Timestamp, Name, Position, Available Timings</code>
              <p style={{margin:"8px 0 0", fontSize:"13px", color:"#aaa"}}>
                Position values: <em>Member, Lead, Drive Team, Pit Captain, Scouting Lead</em><br/>
                Available Timings: comma-separated, e.g. <em>8-9, 9-10, 10-11</em>
              </p>
            </div>

            <button
              style={{...styles.btnPrimary, opacity: csvText ? 1 : 0.4}}
              onClick={handleGenerateSchedule}
              disabled={!csvText}
            >
              Generate & Save Schedule
            </button>

            {schedule && (
              <div style={styles.successBox}>
                ✓ Schedule generated and saved! Share this URL with your team.
              </div>
            )}
          </div>
        )}

        {/* PERSONAL SCHEDULE */}
        {view === "personal" && (
          <div style={styles.panel}>
            <h2 style={styles.panelTitle}>My Schedule</h2>
            {!schedule && <p style={styles.panelDesc}>No schedule uploaded yet. Ask your admin to upload the CSV.</p>}
            {schedule && (
              <>
                <div style={styles.formGroup}>
                  <label style={styles.label}>Your Name</label>
                  <select
                    value={userName}
                    onChange={e => handleUserLogin(e.target.value)}
                    style={styles.input}
                  >
                    <option value="">— Select your name —</option>
                    {allNames.sort().map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>

                {userName && (
                  <>
                    <button
                      style={{...styles.btnSecondary, marginBottom: "24px"}}
                      onClick={() => setupNotifications(userName)}
                    >
                      {notifEnabled ? "✓ Notifications Active" : "🔔 Enable Notifications"}
                    </button>

                    <div style={styles.personalSlots}>
                      {getPersonalSlots(userName).length === 0
                        ? <p style={{color:"#666"}}>You have no assigned slots.</p>
                        : getPersonalSlots(userName).map(({ slot, role }) => {
                            const rs = ROLE_STYLES[role] || ROLE_STYLES["Stands"];
                            return (
                              <div key={slot} style={{...styles.slotCard, borderColor: rs.accent}}>
                                <div style={{...styles.slotTime, color: rs.accent}}>{slot}</div>
                                <div style={{...styles.slotRole, background: rs.accent}}>{rs.label}</div>
                              </div>
                            );
                          })
                      }
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* FULL SCHEDULE */}
        {view === "full" && schedule && (
          <div style={styles.panel}>
            <h2 style={styles.panelTitle}>Full Schedule</h2>
            <div style={styles.scheduleGrid}>
              {TIME_SLOTS.map(slot => {
                const s = schedule[slot];
                if (!s) return null;
                return (
                  <div key={slot} style={styles.scheduleCard}>
                    <div style={styles.scheduleSlotHeader}>{slot}</div>
                    <RoleRow label="Drive Team ★" names={s.driveTeam} accent="#e94560" />
                    <RoleRow label="Pit Captain ★" names={s.pitCaptain ? [s.pitCaptain] : []} accent="#ff6b35" />
                    <RoleRow label="Pits" names={s.pits} accent="#f4a261" />
                    <RoleRow label="Scouting Lead ★" names={s.scoutingLead ? [s.scoutingLead] : []} accent="#0096ff" />
                    <RoleRow label="Scouting" names={s.scouting} accent="#56cfe1" />
                    <RoleRow label="Stands" names={s.stands} accent="#8338ec" />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function RoleRow({ label, names, accent }) {
  if (!names || names.length === 0) return null;
  return (
    <div style={styles.roleRow}>
      <span style={{...styles.roleLabel, color: accent}}>{label}</span>
      <span style={styles.roleNames}>{names.join(", ")}</span>
    </div>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const styles = {
  root: {
    minHeight: "100vh",
    background: "#0a0a0f",
    color: "#e8e8f0",
    fontFamily: "'Courier New', 'Consolas', monospace",
    position: "relative",
    overflow: "hidden",
  },
  noise: {
    position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E")`,
    opacity: 0.4,
  },
  header: {
    borderBottom: "1px solid #1e1e2e",
    background: "rgba(10,10,15,0.95)",
    backdropFilter: "blur(10px)",
    position: "sticky", top: 0, zIndex: 100,
  },
  headerInner: {
    maxWidth: 1100, margin: "0 auto", padding: "0 24px",
    display: "flex", alignItems: "center", justifyContent: "space-between", height: 60,
  },
  logo: { display: "flex", alignItems: "center", gap: 10 },
  logoIcon: { fontSize: 22, color: "#f4a261" },
  logoText: { fontSize: 20, fontWeight: "bold", letterSpacing: 2, color: "#f4a261" },
  nav: { display: "flex", gap: 4 },
  navBtn: {
    background: "none", border: "1px solid transparent", color: "#888",
    padding: "6px 14px", cursor: "pointer", borderRadius: 4,
    fontFamily: "inherit", fontSize: 13, letterSpacing: 1, transition: "all 0.2s",
  },
  navBtnActive: { borderColor: "#f4a261", color: "#f4a261" },
  main: { maxWidth: 1100, margin: "0 auto", padding: "40px 24px", position: "relative", zIndex: 1 },

  // Landing
  landing: { textAlign: "center", padding: "60px 0" },
  heroGlow: {
    position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)",
    width: 600, height: 300, borderRadius: "50%",
    background: "radial-gradient(ellipse, rgba(244,162,97,0.08) 0%, transparent 70%)",
    pointerEvents: "none",
  },
  heroTitle: { fontSize: "clamp(48px,8vw,96px)", margin: "0 0 8px", letterSpacing: 8, color: "#f4a261", fontWeight: "bold" },
  heroSub: { fontSize: 18, color: "#666", letterSpacing: 4, margin: "0 0 24px" },
  heroDesc: { fontSize: 15, color: "#aaa", maxWidth: 500, margin: "0 auto 40px", lineHeight: 1.7 },
  heroButtons: { display: "flex", gap: 16, justifyContent: "center", marginBottom: 60 },
  featureRow: { display: "flex", flexWrap: "wrap", gap: 16, justifyContent: "center", marginTop: 20 },
  featureCard: {
    background: "#111118", border: "1px solid #1e1e2e", borderRadius: 8,
    padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, minWidth: 220,
  },
  featureIcon: { fontSize: 20 },
  featureLabel: { fontSize: 13, color: "#aaa" },

  // Panel
  panel: { maxWidth: 720, margin: "0 auto" },
  panelTitle: { fontSize: 28, fontWeight: "bold", color: "#f4a261", letterSpacing: 2, marginBottom: 8 },
  panelDesc: { color: "#888", marginBottom: 32, fontSize: 14, lineHeight: 1.7 },
  formGroup: { marginBottom: 24 },
  label: { display: "block", fontSize: 12, letterSpacing: 2, color: "#888", marginBottom: 8, textTransform: "uppercase" },
  input: {
    width: "100%", background: "#111118", border: "1px solid #2a2a3e",
    color: "#e8e8f0", padding: "10px 14px", borderRadius: 6,
    fontFamily: "inherit", fontSize: 14, outline: "none", boxSizing: "border-box",
  },
  fileUpload: {
    display: "inline-block", background: "#111118", border: "1px dashed #2a2a3e",
    padding: "12px 20px", borderRadius: 6, cursor: "pointer", fontSize: 14, color: "#aaa",
  },
  fileReady: { marginLeft: 12, color: "#4ade80", fontSize: 13 },
  infoBox: {
    background: "#111118", border: "1px solid #2a2a3e", borderRadius: 8,
    padding: "16px", marginBottom: 24, fontSize: 13, color: "#aaa",
  },
  code: {
    display: "block", background: "#0a0a0f", border: "1px solid #1e1e2e",
    padding: "8px 12px", borderRadius: 4, color: "#56cfe1", fontFamily: "inherit",
    margin: "8px 0", fontSize: 12,
  },
  successBox: {
    marginTop: 20, background: "rgba(74,222,128,0.08)", border: "1px solid rgba(74,222,128,0.3)",
    borderRadius: 8, padding: "14px 18px", color: "#4ade80", fontSize: 14,
  },

  // Buttons
  btnPrimary: {
    background: "#f4a261", color: "#0a0a0f", border: "none", padding: "12px 28px",
    borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 14,
    fontWeight: "bold", letterSpacing: 1, transition: "all 0.2s",
  },
  btnSecondary: {
    background: "none", color: "#f4a261", border: "1px solid #f4a261", padding: "10px 24px",
    borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 14, letterSpacing: 1,
  },

  // Personal slots
  personalSlots: { display: "flex", flexDirection: "column", gap: 12 },
  slotCard: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    background: "#111118", border: "1px solid", borderRadius: 8, padding: "16px 20px",
  },
  slotTime: { fontSize: 20, fontWeight: "bold", letterSpacing: 2 },
  slotRole: { color: "#0a0a0f", padding: "4px 12px", borderRadius: 20, fontSize: 13, fontWeight: "bold" },

  // Full schedule
  scheduleGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 },
  scheduleCard: {
    background: "#111118", border: "1px solid #1e1e2e", borderRadius: 10, padding: "20px",
  },
  scheduleSlotHeader: {
    fontSize: 22, fontWeight: "bold", color: "#f4a261", letterSpacing: 3,
    marginBottom: 16, borderBottom: "1px solid #1e1e2e", paddingBottom: 10,
  },
  roleRow: { marginBottom: 8 },
  roleLabel: { fontSize: 11, letterSpacing: 1, textTransform: "uppercase", display: "block", marginBottom: 2 },
  roleNames: { fontSize: 13, color: "#ccc" },
};
