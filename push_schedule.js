const https = require('https');

// ─── COMPETITION CONFIG ───────────────────────────────────────────────────────
const TIME_SLOTS = ["8-9","9-10","10-11","11-12","12-1","1-2","2-3","3-4","4-5","5-6","6-7"];
const DAYS = ["Thursday","Friday","Saturday"];
const SCOUTS_PER_SLOT = 6;
const MAX_SCOUT_SHIFTS = 5;   // max times someone can scout per day
const MAX_SCOUT_IN_ROW = 2;   // max consecutive scouting slots

// ─── PINNED PROGRAMMER SLOTS ─────────────────────────────────────────────────
// Jake is Lead Programmer (fixed role), so only Peter rotates for pit prog
// No pinned slots needed — Peter handles all prog slots he's available for

// ─── MEMBERS ─────────────────────────────────────────────────────────────────
// sat/fri/thu: true = available all day
// slots: specific slot overrides per day
const allMembers = [
  { name:"Peter Rezkalla",      hasPitProg:true,  hasPitMech:false, thu:true,  fri:true,  sat:true  },
  { name:"Xiaoran Yan",         hasPitProg:false, hasPitMech:true,  thu:true,  fri:true,  sat:true  },
  { name:"Sunny Kota",          hasPitProg:false, hasPitMech:true,  thu:true,  fri:true,  sat:true  },
  { name:"Brennan Murphy",      hasPitProg:false, hasPitMech:true,  thu:true,  fri:true,  sat:false },
  { name:"Liam Harden",         hasPitProg:false, hasPitMech:false, thu:false, fri:true,  sat:true,  thuSlots:["5-6"] },
  { name:"Neil Pant",           hasPitProg:false, hasPitMech:true,  thu:true,  fri:true,  sat:true  },
  { name:"Katie Widmann",       hasPitProg:false, hasPitMech:true,  thu:true,  fri:true,  sat:true  },
  { name:"Ethan Wang",          hasPitProg:false, hasPitMech:true,  thu:true,  fri:true,  sat:true  },
  { name:"Louis Barna",         hasPitProg:false, hasPitMech:true,  thu:false, fri:true,  sat:true,  thuSlots:["5-6"] },
  { name:"Kristen Dodds",       hasPitProg:false, hasPitMech:false, thu:true,  fri:true,  sat:true  },
  { name:"Azim Ahmad Julkipli", hasPitProg:false, hasPitMech:false, thu:false, fri:false, sat:false, satSlots:["9-10","10-11","11-12","12-1","1-2","2-3","3-4","4-5","5-6"] },
  { name:"Dhivansh Kochhar",    hasPitProg:false, hasPitMech:false, thu:true,  fri:true,  sat:true  },
  { name:"Aadi Patel",          hasPitProg:false, hasPitMech:true,  thu:false, fri:false, sat:true  },
  { name:"Aditya Ganesan",      hasPitProg:false, hasPitMech:true,  thu:false, fri:false, sat:true  },
];

const fixedRoles = {
  driveTeam:     ["Charlie Brubach","Dominic Kane","Louis Barna","Kristen Dodds","Dhivansh Kochhar"],
  pitCaptain:    ["Dina Jabini"],
  leadProgrammer:["Jake Widmann"],
  scoutingLead:  ["Albert Wang"],
};

// ─── AVAILABILITY ─────────────────────────────────────────────────────────────
const byName = Object.fromEntries(allMembers.map(m => [m.name, m]));

function avail(name, day, slot) {
  const m = byName[name];
  if (!m) return false;
  const d = day.toLowerCase().slice(0,3); // thu/fri/sat
  // Check specific slot overrides first
  if (d === "thu" && m.thuSlots) return m.thuSlots.includes(slot);
  if (d === "fri" && m.friSlots) return m.friSlots.includes(slot);
  if (d === "sat" && m.satSlots) return m.satSlots.includes(slot);
  // Fall back to all-day flag
  if (d === "thu") return !!m.thu;
  if (d === "fri") return !!m.fri;
  if (d === "sat") return !!m.sat;
  return false;
}

// ─── SCHEDULER ───────────────────────────────────────────────────────────────
function generateSchedule() {
  const schedule = {};

  // Prog and mech queues persist across all days for fair rotation
  const progQueue = allMembers.filter(m => m.hasPitProg).map(m => m.name);
  const mechQueue = allMembers.filter(m => m.hasPitMech && !m.hasPitProg).map(m => m.name);
  const recorderQueue = [...allMembers.map(m => m.name)];
  const scannerQueue  = [...allMembers.map(m => m.name)];

  for (const day of DAYS) {
    schedule[day] = {};

    // Per-person state — resets each day
    const state = {};
    for (const m of allMembers) {
      state[m.name] = {
        scoutCount:     0,    // total scouts this day
        scoutInARow:    0,    // current consecutive scout slots
        lastRole:       null, // last assigned role
        lastRecorder:   -99,
        lastScanner:    -99,
      };
    }

    const dayMembers = allMembers.filter(m =>
      TIME_SLOTS.some(slot => avail(m.name, day, slot))
    );

    for (let i = 0; i < TIME_SLOTS.length; i++) {
      const slot = TIME_SLOTS[i];
      const present = dayMembers.filter(m => avail(m.name, day, slot));
      const used = new Set();

      // ── Pit Programmer (1, round-robin) ──
      let prog = null;
      for (const name of progQueue) {
        if (present.find(m => m.name === name) && !used.has(name)) {
          prog = name; break;
        }
      }
      if (prog) {
        used.add(prog);
        // Rotate to back of queue
        const idx = progQueue.indexOf(prog);
        progQueue.splice(idx, 1);
        progQueue.push(prog);
        state[prog].lastRole = "Pit Programmer";
      }

      // ── Pit Mechanic (1, round-robin) ──
      let mech = null;
      for (const name of mechQueue) {
        if (present.find(m => m.name === name) && !used.has(name)) {
          mech = name; break;
        }
      }
      if (mech) {
        used.add(mech);
        const idx = mechQueue.indexOf(mech);
        mechQueue.splice(idx, 1);
        mechQueue.push(mech);
        state[mech].lastRole = "Pit Mechanic";
      }

      // ── Scouting (6, fair rotation with constraints) ──
      // Rules:
      // 1. Max MAX_SCOUT_IN_ROW consecutive scout slots
      // 2. Max MAX_SCOUT_SHIFTS total per day
      // 3. Prefer people who scouted least recently
      const scoutEligible = present
        .filter(m =>
          !used.has(m.name) &&
          state[m.name].scoutCount < MAX_SCOUT_SHIFTS &&
          state[m.name].scoutInARow < MAX_SCOUT_IN_ROW
        )
        .sort((a, b) => state[a.name].scoutCount - state[b.name].scoutCount);

      const scouting = [];
      for (const m of scoutEligible) {
        if (scouting.length >= SCOUTS_PER_SLOT) break;
        scouting.push(m.name);
        used.add(m.name);
        state[m.name].scoutCount++;
        state[m.name].scoutInARow++;
        state[m.name].lastRole = "Scouting";
      }

      // Reset scoutInARow for people who didn't scout this slot
      for (const m of present) {
        if (!scouting.includes(m.name)) {
          state[m.name].scoutInARow = 0;
        }
      }

      // ── Recorder (1 from remaining, min 2-slot gap) ──
      const offPool = present.filter(m => !used.has(m.name)).map(m => m.name);
      let recorder = null;
      for (const name of recorderQueue) {
        if (offPool.includes(name) && (i - state[name].lastRecorder) > 2) {
          recorder = name; break;
        }
      }
      if (recorder) {
        used.add(recorder);
        state[recorder].lastRecorder = i;
        state[recorder].lastRole = "Recorder";
        const idx = recorderQueue.indexOf(recorder);
        recorderQueue.splice(idx, 1);
        recorderQueue.push(recorder);
      }

      // ── Scanner (1 from remaining, min 2-slot gap) ──
      const offPool2 = present.filter(m => !used.has(m.name)).map(m => m.name);
      let scanner = null;
      for (const name of scannerQueue) {
        if (offPool2.includes(name) && (i - state[name].lastScanner) > 2) {
          scanner = name; break;
        }
      }
      if (scanner) {
        used.add(scanner);
        state[scanner].lastScanner = i;
        state[scanner].lastRole = "Scanner";
        const idx = scannerQueue.indexOf(scanner);
        scannerQueue.splice(idx, 1);
        scannerQueue.push(scanner);
      }

      // ── Off ──
      const off = present.filter(m => !used.has(m.name)).map(m => m.name);
      for (const m of off) state[m.name].lastRole = "Off";

      schedule[day][slot] = {
        pitProg:  prog     ? [prog]     : [],
        pitMech:  mech     ? [mech]     : [],
        scouting,
        recorder: recorder ? [recorder] : [],
        scanner:  scanner  ? [scanner]  : [],
        off,
      };

      console.log(`${day} ${slot}: P=${prog||"-"} M=${mech||"-"} S(${scouting.length}) R=${recorder||"-"} SC=${scanner||"-"}`);
    }
  }
  return schedule;
}

// ─── SAVE TO JSONBIN ──────────────────────────────────────────────────────────
const schedule = generateSchedule();
const payload = JSON.stringify({
  schedule,
  fixedRoles,
  days: DAYS,
  dayDates: { Thursday:"", Friday:"", Saturday:"" }
});

const options = {
  hostname: 'api.jsonbin.io',
  path: '/v3/b/69c713c1aa77b81da92916cd',
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'X-Master-Key': '$2a$10$sw7DsOPVqOXjcl1OYlh3Te3ogd1vDTGKkJQNm9E0qb3r9G6uMSGJS',
    'Content-Length': Buffer.byteLength(payload),
  },
};

const req = https.request(options, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    if (res.statusCode === 200) console.log('\n✓ Schedule saved! Refresh the site.');
    else console.log('\n✗ Error:', res.statusCode, d);
  });
});
req.on('error', e => console.error('Error:', e.message));
req.write(payload);
req.end();