import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const base = new URL('../', import.meta.url);
const load = async (name) => JSON.parse(await readFile(new URL(name,base),'utf8'));
const [manifest, motion, copy] = await Promise.all(['assets.manifest.json','motion.tokens.json','copy.zh-CN.json'].map(load));
const ids = new Set(manifest.assets.map(a=>a.id));
assert.equal(ids.size,manifest.assets.length,'duplicate IDs');
assert.equal(manifest.productionAssetCount,ids.size);
assert.deepEqual(manifest.sceneIds,['S01','S02','S03','S04','UI']);
for (const a of manifest.assets) {
  assert.ok(manifest.sceneIds.includes(a.scene));
  assert.ok(ids.has(a.parent)||manifest.sceneIds.includes(a.parent),`missing parent for ${a.id}`);
  assert.ok(manifest.allowedAssetStatuses.includes(a.status));
  assert.ok(a.pivot.length===2 && a.pivot.every(v=>Number.isFinite(v)&&v>=0&&v<=1));
  if (a.status==='planned') { assert.equal(a.actualPath,null); assert.equal(a.sha256,null); }
  else { assert.ok(typeof a.actualPath==='string' && a.actualPath.length>0); assert.match(a.sha256,/^[0-9a-f]{64}$/); }
  let parent=a.parent; const seen=new Set([a.id]);
  while(ids.has(parent)){assert.ok(!seen.has(parent),'parent cycle');seen.add(parent);parent=manifest.assets.find(x=>x.id===parent).parent;}
}
for(const r of manifest.references){const bytes=await readFile(new URL(r.path,base));assert.equal(createHash('sha256').update(bytes).digest('hex'),r.sha256,'reference modified');}
assert.equal(copy.memory.title,'不只是回答你，也记住你说过的话。');
for(const key of ['hero','memory','letters','ocean']) for(const bad of copy.constraints.doNotUseInMarketingHeadline) assert.ok(!copy[key].title.includes(bad));
assert.deepEqual(motion.testProgress,[0,.25,.5,.75,1]);
assert.ok(Object.values(motion.duration).every(v=>Number.isFinite(v)&&v>=0));
assert.equal(motion.preferences.systemReduceWins,true);
assert.equal(motion.quality.noApiCallsFromDecoration,true);
assert.ok(Object.values(motion.preferences.reduced).every(v=>v===false));
console.log(JSON.stringify({status:'pass',productionAssets:ids.size,planned:manifest.assets.filter(a=>a.status==='planned').length,verifiedOriginalReferences:manifest.references.length,copyLock:'pass',motionContract:'pass'},null,2));
