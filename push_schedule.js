const https = require('https');
const TIME_SLOTS = ["8-9","9-10","10-11","11-12","12-1","1-2","2-3","3-4","4-5","5-6"];
const SUNDAY_SLOTS = ["8-9","9-10","10-11","11-12","12-1"];
const SCOUTING_PER_SLOT = 6;
const PINNED_PROG = { "11-12":"Aryan Mitra", "1-2":"Kartik Gupta", "3-4":"Kartik Gupta" };

const allMembers = [
  { name:"Ethan Wang",        hasPitProg:false, hasPitMech:true,  sat:true,  sun:true  },
  { name:"Shaun Mathew",      hasPitProg:true,  hasPitMech:false, sat:true,  sun:true  },
  { name:"Kartik Gupta",      hasPitProg:true,  hasPitMech:false, sat:true,  sun:true  },
  { name:"Aryan Mitra",       hasPitProg:false, hasPitMech:false, sat:true,  sun:true  },
  { name:"Krish Kesarkar",    hasPitProg:false, hasPitMech:true,  sat:true,  sun:true  },
  { name:"Brennan Murphy",    hasPitProg:false, hasPitMech:true,  sat:true,  sun:true  },
  { name:"Aadi Patel",        hasPitProg:false, hasPitMech:true,  sat:true,  sun:true  },
  { name:"Xiaoran Yan",       hasPitProg:false, hasPitMech:true,  sat:true,  sun:true  },
  { name:"Ethan Smith",       hasPitProg:false, hasPitMech:false, sat:true,  sun:true  },
  { name:"Katie Widmann",     hasPitProg:false, hasPitMech:true,  sat:true,  sun:true  },
  { name:"Kunj Tailor",       hasPitProg:false, hasPitMech:true,  sat:true,  sun:true  },
  { name:"Arjun Iyer",        hasPitProg:false, hasPitMech:true,  satSlots:["10-11","11-12","12-1","1-2","2-3","3-4"], sunSlots:["10-11","11-12","12-1","1-2","2-3"] },
  { name:"Liam Harden",       hasPitProg:false, hasPitMech:false, sat:true,  sun:true  },
  { name:"Subhash Muthu",     hasPitProg:true,  hasPitMech:false, sat:true,  sun:false },
  { name:"Peter Rezkalla",    hasPitProg:true,  hasPitMech:false, sat:true,  sun:true  },
  { name:"Tyler Schmale",     hasPitProg:true,  hasPitMech:false, sat:true,  sun:true  },
  { name:"Alicia Lu",         hasPitProg:false, hasPitMech:false, sat:true,  sun:true  },
  { name:"Sunny Kota",        hasPitProg:false, hasPitMech:true,  sat:true,  sun:true  },
  { name:"Aditya Ganesan",    hasPitProg:false, hasPitMech:true,  sat:true,  sun:true  },
  { name:"Thisath Halambage", hasPitProg:false, hasPitMech:true,  sat:false, sun:true  },
  { name:"Aarush Chaudhari",  hasPitProg:false, hasPitMech:false, sat:true,  sun:true  },
];

const fixedRoles = {
  driveTeam:["Dominic Kane","Charlie Brubach","Dhivansh Kochhar","Kristen Dodds","Louis Barna"],
  pitCaptain:["Dina Jabini"], leadProgrammer:["Jake Widmann"], scoutingLead:["Albert Wang"]
};

const byName = Object.fromEntries(allMembers.map(m=>[m.name,m]));

function avail(name, day, slot) {
  const m=byName[name]; if(!m) return false;
  if(m.satSlots&&day==="Saturday") return m.satSlots.includes(slot);
  if(m.sunSlots&&day==="Sunday") return m.sunSlots.includes(slot);
  if(day==="Saturday") return !!m.sat;
  if(day==="Sunday") return !!m.sun;
  return false;
}

const PROG_EXCLUDE = new Set(["Aryan Mitra","Thisath Halambage","Kartik Gupta"]);
let progQueue = allMembers.filter(m=>m.hasPitProg&&!PROG_EXCLUDE.has(m.name)).map(m=>m.name);
const inProgQueue = new Set(progQueue);
let mechQueue = allMembers.filter(m=>m.hasPitMech&&!inProgQueue.has(m.name)).map(m=>m.name);
let recorderQueue = allMembers.filter(m=>m.name!=="Aryan Mitra").map(m=>m.name);
for(const m of allMembers){m.lastScoutIdx=-99;m.lastRecorderIdx=-99;}

const schedule={};
for(const day of ["Saturday","Sunday"]) {
  schedule[day]={};
  for(const m of allMembers){m.lastScoutIdx=-99;m.lastRecorderIdx=-99;}
  const slots=day==="Sunday"?SUNDAY_SLOTS:TIME_SLOTS;
  for(let i=0;i<slots.length;i++){
    const slot=slots[i];
    const used=new Set();
    let prog=null,mech=null;

    const pinnedProg=PINNED_PROG[slot];
    if(pinnedProg&&avail(pinnedProg,day,slot)){
      prog=pinnedProg;
    } else if(!pinnedProg){
      for(const name of progQueue){if(avail(name,day,slot)&&!used.has(name)){prog=name;break;}}
      if(prog) progQueue=[...progQueue.filter(n=>n!==prog),prog];
    }
    if(prog) used.add(prog);

    for(const name of mechQueue){if(avail(name,day,slot)&&!used.has(name)){mech=name;break;}}
    if(mech){used.add(mech);mechQueue=[...mechQueue.filter(n=>n!==mech),mech];}

    const scoutPool=allMembers.filter(m=>avail(m.name,day,slot)&&!used.has(m.name))
      .sort((a,b)=>(a.lastScoutIdx??-99)-(b.lastScoutIdx??-99));
    const scouting=[];
    for(const m of scoutPool){
      if(scouting.length>=SCOUTING_PER_SLOT) break;
      scouting.push(m.name);used.add(m.name);m.lastScoutIdx=i;
    }

    const offAll=allMembers.filter(m=>avail(m.name,day,slot)&&!used.has(m.name)).map(m=>m.name);
    let recorder=null;
    for(const name of recorderQueue){
      if(offAll.includes(name)&&name!=="Aryan Mitra"&&(i-(byName[name].lastRecorderIdx??-99))>2){
        recorder=name;break;
      }
    }
    if(recorder){byName[recorder].lastRecorderIdx=i;recorderQueue=[...recorderQueue.filter(n=>n!==recorder),recorder];}
    const off=offAll.filter(n=>n!==recorder);

    schedule[day][slot]={pitProg:prog?[prog]:[],pitMech:mech?[mech]:[],scouting,recorder:recorder?[recorder]:[],off};
    console.log(`${day} ${slot}: P=${prog||"?"} M=${mech||"?"} R=${recorder||"?"}`);
  }
}

const payload=JSON.stringify({schedule,fixedRoles,days:["Saturday","Sunday"],dayDates:{Saturday:"",Sunday:""}});
const options={
  hostname:'api.jsonbin.io',path:'/v3/b/69b361f5c3097a1dd51e8c8b',method:'PUT',
  headers:{'Content-Type':'application/json','X-Master-Key':'$2a$10$sw7DsOPVqOXjcl1OYlh3Te3ogd1vDTGKkJQNm9E0qb3r9G6uMSGJS','Content-Length':Buffer.byteLength(payload)}
};
const req=https.request(options,(res)=>{
  let d='';res.on('data',c=>d+=c);
  res.on('end',()=>{
    if(res.statusCode===200) console.log('\n✓ Schedule saved to JSONBin! Refresh the site.');
    else console.log('\n✗ Error saving:',res.statusCode,d);
  });
});
req.on('error',e=>console.error('Error:',e.message));
req.write(payload);
req.end();
