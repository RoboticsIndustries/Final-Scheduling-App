const https = require('https');
const { execSync } = require('child_process');

const options = {
  hostname: 'api.jsonbin.io',
  path: '/v3/b/69c713c1aa77b81da92916cd/latest',
  headers: {
    'X-Master-Key': '$2a$10$sw7DsOPVqOXjcl1OYlh3Te3ogd1vDTGKkJQNm9E0qb3r9G6uMSGJS',
    'X-Bin-Meta': 'false'
  }
};

https.get(options, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    require('fs').writeFileSync('schedule.json', d);
    execSync('pbcopy < schedule.json');
    console.log('Copied to clipboard! Paste into Admin panel.');
  });
}).on('error', e => console.error('Error:', e.message));