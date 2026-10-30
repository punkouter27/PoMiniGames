import fs from 'node:fs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RAW = 'scratch-opentdb/raw.json';
const raw = fs.existsSync(RAW) ? JSON.parse(fs.readFileSync(RAW, 'utf8')) : [];
const log = (m) => console.log(new Date().toISOString().slice(11, 19), m);

async function get(url) {
    for (let attempt = 0; attempt < 8; attempt++) {
        await sleep(5200);
        try {
            const res = await fetch(url);
            if (res.status === 429) { log('429, backing off'); await sleep(10000); continue; }
            const body = await res.json();
            if (body.response_code === 5) { log('code 5, backing off'); await sleep(10000); continue; }
            return body;
        } catch (e) { log('error ' + e.message); await sleep(8000); }
    }
    throw new Error('giving up on ' + url);
}

const decode = (s) => Buffer.from(s, 'base64').toString('utf8');
let tokenRes = await get('https://opentdb.com/api_token.php?command=request');
let token = tokenRes.token;
let amount = 50, resets = 0, empty = 0;

while (resets < 1 && empty < 3) {
    const body = await get(`https://opentdb.com/api.php?amount=${amount}&type=multiple&encode=base64&token=${token}`);
    if (body.response_code === 0) {
        for (const r of body.results) {
            raw.push({
                cat: decode(r.category), d: decode(r.difficulty), q: decode(r.question),
                a: decode(r.correct_answer), w: r.incorrect_answers.map(decode),
            });
        }
        empty = 0;
        fs.writeFileSync(RAW, JSON.stringify(raw));
        log(`got ${body.results.length}, total ${raw.length}`);
    } else if (body.response_code === 4) {
        log('code 4 (token exhausted) -> reset');
        resets++;
        await get(`https://opentdb.com/api_token.php?command=reset&token=${token}`);
    } else if (body.response_code === 1) {
        if (amount > 1) { amount = Math.max(1, Math.floor(amount / 2)); log('code 1, amount ' + amount); }
        else { empty++; log('code 1 at amount 1'); }
    } else if (body.response_code === 3 || body.response_code === 2) {
        log('token invalid, requesting new');
        token = (await get('https://opentdb.com/api_token.php?command=request')).token;
    }
}
log('done, raw ' + raw.length);
