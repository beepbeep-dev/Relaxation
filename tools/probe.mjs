import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const ROOT = new URL('../dist/', import.meta.url).pathname;
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const server = createServer(async (req,res)=>{ try{
  const rel = normalize(decodeURI(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/,'');
  const p = join(ROOT, rel==='/'?'index.html':rel);
  res.writeHead(200,{'content-type':TYPES[extname(p)]??'application/octet-stream'}); res.end(await readFile(p));
}catch{res.writeHead(404).end('x');}});
await new Promise(r=>server.listen(0,r));
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH, args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
const page = await browser.newPage({viewport:{width:640,height:360}});
page.on('pageerror', e => console.log('ERR', String(e).slice(0,400)));
await page.goto(`http://localhost:${server.address().port}/`);
await page.waitForFunction(()=>!!window.__kaisei,null,{timeout:45000});
await page.waitForFunction(()=>!document.getElementById('enter').disabled);
await page.click('#enter');
await page.waitForSelector('#boot',{state:'detached'});

const aimUp = async () => page.evaluate(async () => {
  const k = window.__kaisei;
  k.player.seated = true;
  k.engine.rig.position.set(0, 2, 0);
  k.engine.camera.rotation.set(1.3, 0, 0, 'YXZ');
  await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
  const gl = k.engine.renderer.getContext();
  const px = new Uint8Array(4);
  gl.readPixels(320, 180, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return Array.from(px);
});

console.log('1. as-is, looking up:', await aimUp());

console.log('2. geometry attribute intact:', await page.evaluate(() => {
  const k = window.__kaisei;
  const sky = k.engine.scene.children.find(c => c.geometry?.type === 'SphereGeometry');
  return { found: !!sky, posCount: sky?.geometry.attributes.position?.count, visible: sky?.visible };
}));

// Swap in a flat magenta unlit material. If this shows, the mesh draws fine
// and the fault is in the sky shader; if not, the mesh never reaches the eye.
console.log('3. flat magenta material:', await page.evaluate(async () => {
  const k = window.__kaisei;
  const sky = k.engine.scene.children.find(c => c.geometry?.type === 'SphereGeometry');
  const Basic = k.racing.gateRings.material.constructor;
  sky.material = new Basic({ color: 0xff00ff, side: 1, depthWrite: false, fog: false });
  return 'swapped';
}));
console.log('   pixel now:', await aimUp());

// Hide every top-level object except the sky: what is drawing over it?
console.log('4. sky alone:', await page.evaluate(() => {
  const k = window.__kaisei;
  const sky = k.engine.scene.children.find(c => c.geometry?.type === 'SphereGeometry');
  window.__hidden = [];
  for (const c of k.engine.scene.children) {
    if (c !== sky && c.visible) { window.__hidden.push(c); c.visible = false; }
  }
  return window.__hidden.map(c => `${c.type}:${c.name || c.children.length + ' kids'}`);
}));
console.log('   pixel now:', await aimUp());

// Re-show one at a time and find the culprit.
console.log('5. re-showing each:');
const n = await page.evaluate(() => window.__hidden.length);
for (let i = 0; i < n; i++) {
  const info = await page.evaluate((i) => {
    const c = window.__hidden[i];
    for (const h of window.__hidden) h.visible = false;
    c.visible = true;
    return `${c.type} (${c.children.length} children)`;
  }, i);
  console.log(`   ${info} ->`, await aimUp());
}

// Bisect inside the lounge.
console.log('6. lounge children:');
const kids = await page.evaluate(() => {
  const k = window.__kaisei;
  for (const c of window.__hidden) c.visible = false;
  k.lounge.group.visible = true;
  return k.lounge.group.children.map((c, i) =>
    `${i} ${c.type} ${c.geometry?.type ?? ''} pos=${c.position.toArray().map(v=>v.toFixed(1)).join(',')}`);
});
for (let i = 0; i < kids.length; i++) {
  const px = await page.evaluate(async (i) => {
    const k = window.__kaisei;
    k.lounge.group.children.forEach((c, j) => { c.visible = j === i; });
    return true;
  }, i);
  const val = await aimUp();
  if (val[0] > 5 || val[1] > 5 || val[2] > 5) {
    if (!(val[0] > 200 && val[2] > 200)) console.log(`   OCCLUDER -> ${kids[i]}`, val);
  }
}

await browser.close(); server.close();
