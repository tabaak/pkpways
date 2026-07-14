import Redis from 'ioredis';
import fs from 'fs';
const env = Object.fromEntries(fs.readFileSync('.env.local','utf8').split('\n')
  .filter(l=>l.includes('=')&&!l.trim().startsWith('#'))
  .map(l=>[l.slice(0,l.indexOf('=')).trim(), l.slice(l.indexOf('=')+1).trim()]));
const r = new Redis(env.REDIS_URL);
const grab = async () => {
  const all = await r.info();
  const g = k => (all.match(new RegExp('^'+k+':(.*)$','m'))||[])[1]?.trim();
  return { cmds: g('total_commands_processed'), expired: g('expired_keys'), clients: g('connected_clients'),
           keyspace: (all.split('# Keyspace')[1]||'').trim() || '(no databases)', maxmem: g('maxmemory_policy'),
           evicted: g('evicted_keys'), used: g('used_memory_human') };
};
const a = await grab();
console.log('t0:', JSON.stringify(a, null, 1));
console.log('...waiting 40s to span a worker poll cycle...');
await new Promise(r => setTimeout(r, 40000));
const b = await grab();
console.log('t1:', JSON.stringify(b, null, 1));
console.log('commands delta:', Number(b.cmds) - Number(a.cmds));
console.log('expired delta:', Number(b.expired) - Number(a.expired));
console.log('CLIENT LIST:'); console.log(await r.client('LIST'));
await r.quit();
