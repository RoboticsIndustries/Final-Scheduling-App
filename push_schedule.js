const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BIN_ID  = "69c713c1aa77b81da92916cd";
const API_KEY = "$2a$10$sw7DsOPVqOXjcl1OYlh3Te3ogd1vDTGKkJQNm9E0qb3r9G6uMSGJS";

// Find the CSV file — looks for any .csv in the current directory
function findCSV() {
  const files = fs.readdirSync('.').filter(f => f.endsWith('.csv'));
  if (!files.length) throw new Error("No CSV file found in current directory. Put your CSV here.");
  console.log(`Using CSV: ${files[0]}`);
  return fs.readFileSync(files[0], 'utf8');
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const ALL_SLOTS        = ["8-9","9-10","10-11","11-12","12-1","1-2","2-3","3-4","4-5","5-6","6-7"];
const SCOUTS_PER_SLOT  = 6;
const MAX_SCOUT_IN_ROW = 2;
const MAX_SCOUT_PER_DAY = 5;
const FIXED_POSITIONS  = new Set(["Drive Team","Pit Captain","Scouting Lead","Lead Programmer"]);

function normalizeSlot(raw) {
  return raw.trim().replace(/\s*(AM|PM)/gi, "").trim();
}

function classifyRole(roleRaw) {
  const r = (roleRaw || "").trim().toLowerCase();
  if (r.includes("drive"))         return "Drive Team";
  if (r.includes("pit captain"))   return "Pit Captain";
  if (r.includes("scouting lead")) return "Scouting Lead";
  if (r.includes("lead"))          return "Lead Programmer";
  return "Member";
}

function detectFormat(headerRow) {
  const h = headerRow.join(" ").toLowerCase();
  return (h.includes("thurs") || h.includes("thu")) ? "new" : "old";
}

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
  console.log(`Detected format: ${format} (${format === "new" ? "Thu/Fri/Sat" : "Fri/Sat/Sun"})`);

  const membersMap = {};

  for (const line of rawLines.slice(1)) {
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
      roleCol = 12; progCol = 13; mechCol = 14;
      const thuAll = (line[5] || "").trim().toLowerCase();
      const thuRaw = (line[6] || "").trim();
      const friAll = (line[7] || "").trim().toLowerCase();
      const friRaw = (line[8] || "").trim();
      const satAll = (line[9] || "").trim().toLowerCase();
      const satRaw = (line[10] || "").trim();

      const thuSlots = thuAll === "yes" ? [...ALL_SLOTS] : thuRaw ? thuRaw.split(",").map(normalizeSlot).filter(s => ALL_SLOTS.includes(s)) : [];
      const friSlots = friAll === "yes" ? [...ALL_SLOTS] : friRaw ? friRaw.split(",").map(normalizeSlot).filter(s => ALL_SLOTS.includes(s)) : [];
      const satSlots = satAll === "yes" ? [...ALL_SLOTS] : satRaw ? satRaw.split(",").map(normalizeSlot).filter(s => ALL_SLOTS.includes(s)) : [];

      if (thuSlots.length) timingsByDay["Thursday"] = thuSlots;
      if (friSlots.length) timingsByDay["Friday"]   = friSlots;
      if (satSlots.length) timingsByDay["Saturday"] = satSlots;
    } else {
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

      const satSlots = satAll === "yes" ? [...ALL_SLOTS] : satRaw ? satRaw.split(",").map(normalizeSlot).filter(s => ALL_SLOTS.includes(s)) : [];
      const sunSlots = sunAll === "yes" ? [...ALL_SLOTS] : sunRaw ? sunRaw.split(",").map(normalizeSlot).filter(s => ALL_SLOTS.includes(s)) : [];

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
      membersMap[name].hasPitProg = membersMap[name].hasPitProg || hasPitProg;
      membersMap[name].hasPitMech = membersMap[name].hasPitMech || hasPitMech;
      for (const [day, slots] of Object.entries(timingsByDay)) {
        if (!membersMap[name].timingsByDay[day]) membersMap[name].timingsByDay[day] = [];
        for (const s of slots) if (!membersMap[name].timingsByDay[day].includes(s)) membersMap[name].timingsByDay[day].push(s);
      }
    } else {
      membersMap[name] = { position, hasPitProg, hasPitMech, timingsByDay };
    }
  }

  const fixedRoles = { driveTeam: [], pitCaptain: [], leadProgrammer: [], scoutingLead: [] };
  const members    = [];

  for (const [name, info] of Object.entries(membersMap)) {
    if (FIXED_POSITIONS.has(info.position)) {
      switch (info.position) {
        case "Drive Team":      fixedRoles.driveTeam.push(name);      break;
        case "Pit Captain":     fixedRoles.pitCaptain.push(name);     break;
        case "Scouting Lead":   fixedRoles.scoutingLead.push(name);   break;
        case "Lead Programmer": fixedRoles.leadProgrammer.push(name); break;
        default: break;
      }
    } else {
      members.push({ name, hasPitProg: info.hasPitProg, hasPitMech: info.hasPitMech, timingsByDay: info.timingsByDay });
    }
  }

  const dayOrder = ["Thursday","Friday","Saturday","Sunday"];
  const days = dayOrder.filter(d => members.some(m => (m.timingsByDay[d] || []).length > 0));

  console.log(`\nFixed roles:`);
  console.log(`  Drive Team: ${fixedRoles.driveTeam.join(", ") || "none"}`);
  console.log(`  Pit Captain: ${fixedRoles.pitCaptain.join(", ") || "none"}`);
  console.log(`  Lead Programmer: ${fixedRoles.leadProgrammer.join(", ") || "none"}`);
  console.log(`  Scouting Lead: ${fixedRoles.scoutingLead.join(", ") || "none"}`);
  console.log(`\nSchedulable members (${members.length}):`);
  for (const m of members) {
    const certs = [m.hasPitProg?"PitProg":"", m.hasPitMech?"PitMech":""].filter(Boolean).join("+") || "no cert";
    console.log(`  ${m.name} [${certs}] days: ${Object.keys(m.timingsByDay).join(", ")}`);
  }
  console.log(`\nDays: ${days.join(", ")}\n`);

  return { members, fixedRoles, days };
}

function generateSchedule(members, days) {
  const schedule = {};
  const byName   = Object.fromEntries(members.map(m => [m.name, m]));

  // Build queues — persist across all days
  const progQueue = members.filter(m => m.hasPitProg).map(m => m.name);
  const mechOnly  = members.filter(m => m.hasPitMech && !m.hasPitProg).map(m => m.name);
  const recorderQueue = members.map(m => m.name);

  console.log(`Pit Programmer queue: ${progQueue.join(", ") || "EMPTY — no one has pit prog cert!"}`);
  console.log(`Pit Mechanic queue:   ${mechOnly.join(", ") || "EMPTY — no one has pit mech cert (not in prog queue)!"}`);

  for (const day of days) {
    schedule[day] = {};
    const state = {};
    for (const m of members) state[m.name] = { scoutCount:0, scoutInARow:0, lastRecorder:-99 };

    const dayMembers = members.filter(m => (m.timingsByDay[day] || []).length > 0);

    for (let i = 0; i < ALL_SLOTS.length; i++) {
      const slot = ALL_SLOTS[i];
      const here = (name) => (byName[name]?.timingsByDay[day] || []).includes(slot);
      const used = new Set();

      // Pit Programmer
      let prog = null;
      for (let j = 0; j < progQueue.length; j++) {
        if (here(progQueue[j]) && !used.has(progQueue[j])) {
          prog = progQueue[j];
          progQueue.splice(j, 1); progQueue.push(prog);
          break;
        }
      }
      if (prog) used.add(prog);

      // Pit Mechanic
      let mech = null;
      for (let j = 0; j < mechOnly.length; j++) {
        if (here(mechOnly[j]) && !used.has(mechOnly[j])) {
          mech = mechOnly[j];
          mechOnly.splice(j, 1); mechOnly.push(mech);
          break;
        }
      }
      if (mech) used.add(mech);

      // Scouting
      const scoutEligible = dayMembers
        .filter(m => here(m.name) && !used.has(m.name) &&
          state[m.name].scoutCount  < MAX_SCOUT_PER_DAY &&
          state[m.name].scoutInARow < MAX_SCOUT_IN_ROW)
        .sort((a, b) => state[a.name].scoutCount - state[b.name].scoutCount);
      const scouting = [];
      for (const m of scoutEligible) {
        if (scouting.length >= SCOUTS_PER_SLOT) break;
        scouting.push(m.name); used.add(m.name);
        state[m.name].scoutCount++; state[m.name].scoutInARow++;
      }
      for (const m of dayMembers) { if (!scouting.includes(m.name)) state[m.name].scoutInARow = 0; }

      // Recorder
      const offPool = dayMembers.filter(m => here(m.name) && !used.has(m.name)).map(m => m.name);
      let recorder = null;
      for (let j = 0; j < recorderQueue.length; j++) {
        const n = recorderQueue[j];
        if (offPool.includes(n) && (i - state[n].lastRecorder) > 2) {
          recorder = n;
          recorderQueue.splice(j, 1); recorderQueue.push(n);
          break;
        }
      }
      if (recorder) { used.add(recorder); state[recorder].lastRecorder = i; }

      const off = dayMembers.filter(m => here(m.name) && !used.has(m.name)).map(m => m.name);

      schedule[day][slot] = {
        pitProg:  prog     ? [prog]     : [],
        pitMech:  mech     ? [mech]     : [],
        scouting,
        recorder: recorder ? [recorder] : [],
        off,
      };

      console.log(`${day} ${slot}: PROG=${prog||"-"} MECH=${mech||"-"} scouts=${scouting.length} REC=${recorder||"-"}`);
    }
  }
  return schedule;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
const csvText = findCSV();
const { members, fixedRoles, days } = parseCSV(csvText);
const schedule = generateSchedule(members, days);

const payload = JSON.stringify({
  schedule, fixedRoles, days,
  dayDates: Object.fromEntries(days.map(d => [d, ""]))
});

const options = {
  hostname: 'api.jsonbin.io',
  path: `/v3/b/${BIN_ID}`,
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'X-Master-Key': API_KEY,
    'Content-Length': Buffer.byteLength(payload),
  },
};

console.log("\nSaving to JSONBin...");
const req = https.request(options, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    if (res.statusCode === 200) console.log('✓ Schedule saved! Refresh the site.');
    else console.log('✗ Error:', res.statusCode, d);
  });
});
req.on('error', e => console.error('Error:', e.message));
req.write(payload);
req.end();