/* Isolated reproductions of branches at commit 780a766.
 * Copied predicates and decision order; Zod parsing, persistence and LLM calls
 * are intentionally not exercised. This is NOT the repository test suite.
 */
const LISTEN = /(?:先听我说|听我说就好|只想(?:说说|吐槽|倾诉)|不(?:用|要|必|急着).{0,5}(?:建议|分析|解决)|别.{0,4}(?:建议|分析|追问)|just listen|(?:don't|do not|no) (?:give (?:me )?)?(?:advice|analy[sz]e))/iu;
const ADVICE = /(?:请.{0,6}(?:建议|帮我|分析)|给我.{0,6}(?:建议|办法|方案)|帮我.{0,6}(?:分析|想想|解决|决定|选)|我(?:该|应该)怎么(?:办|做)|有什么(?:建议|办法)|你建议|what should I do|(?:give me|I (?:want|need)) (?:some )?(?:advice|help)|help me (?:decide|solve|plan|understand))/iu;
const DETAIL = /(?:详细|深入|逐步|一步一步|多角度|全面|完整方案|深度分析|in detail|step[- ]by[- ]step|thorough|comprehensive)/iu;
const DETAIL_REQUEST = /(?:请|帮我|给我|我想(?:听|了解|知道)|我需要|你能|能不能|可以.{0,3}(?:说|讲)|(?:详细|深入|逐步|一步一步|多角度|全面).{0,3}(?:说说|讲讲|分析一下)|^(?:详细|深入|逐步|全面)(?:分析|解释)|\b(?:please|could you|can you|explain|describe|give me|I want|I need)\b)/iu;
const NEGATED_DETAIL = /(?:(?:不用|不要|不必|无需|别).{0,6}(?:详细|深入|逐步|全面|分析)|(?:not|don't|do not|no need).{0,16}(?:detail|analy[sz]|thorough))/iu;
const VENTING = /(?:为什么|为何).{0,14}(?:我总|我又|我老|搞砸|倒霉|这么难|不顺)|(?:难过|委屈|烦死|好烦|挫败|好累|想哭|沮丧|好崩溃)|why (?:do I always|am I always|does (?:this|everything) always)|(?:so frustrated|feel awful|feel terrible)/iu;
const RECOLLECTION = /(?:还记得|记不记得|回顾|回想|以前.{0,8}(?:说过|聊过)|之前.{0,8}(?:说过|聊过)|这些年|一路走来|do you remember|look back|reminisce)/iu;
const REFERENCES = /(?:她|他|它|那件事|这件事|那样|这样|那个人|那个|\b(?:she|he|they|that person|that thing|it)\b)/giu;
const LIFE = /(?:你.{0,5}(?:今天|最近|近况|过得|在忙|有什么新鲜事)|(?:how (?:was|is) your day|what have you been up to))/iu;
function plan(query, recent = []) {
 const listen = LISTEN.test(query);
 const detailedAnalysisRequested = DETAIL.test(query) && DETAIL_REQUEST.test(query) && !NEGATED_DETAIL.test(query);
 const adviceRequested = !listen && ADVICE.test(query);
 const recollection = RECOLLECTION.test(query), venting = VENTING.test(query);
 const references = [...new Set(query.match(REFERENCES) ?? [])].slice(0,8);
 const sources = references.length ? recent.filter(m => m.agentId==='a' && m.sessionId==='s' && m.role==='user' && m.text.length<=1200).slice(-3):[];
 const intent = adviceRequested || detailedAnalysisRequested ? 'help' : recollection ? 'recollection' : listen || venting ? 'venting' : /(?:对不起|我们.{0,5}(?:误会|吵架)|sorry (?:about|for))/iu.test(query) ? 'relationship_repair' : /(?:今天|刚才|分享|发生了|today|just happened)/iu.test(query) ? 'sharing' : 'casual';
 return {originalQuery:query, expandedQueries:[...new Set(sources.map(m=>m.text))],contextMessageIds:sources.map(m=>m.id),unresolvedReferences:references,intent,adviceRequested,supportStyle:adviceRequested||detailedAnalysisRequested?'offer_requested_help':listen||venting?'listen':'respond_naturally',allowCharacterLifeMention:LIFE.test(query)};
}
function normalizeText(v){return v.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu,' ').trim();}
function matchesConversationTopic(topic,currentText){const anchor=normalizeText(topic).replace(/(?:烦恼|挫折|压力|问题|相关|事情|感受|关系|方面|的)/gu,'').trim();if(anchor.length<2)return false;const current=normalizeText(currentText);return /\p{Script=Han}/u.test(anchor)?current.includes(anchor):` ${current} `.includes(` ${anchor} `);}
function selectLife(context,plan){const sourceIds=new Set(plan.contextMessageIds);const relevantSource=[...context.recentDecisions,...context.recentDecisionDilemmas,...context.activePressure,...context.reflections].some(i=>i.sourceMessageIds.some(id=>sourceIds.has(id)));const query=[plan.originalQuery,...plan.expandedQueries].join('\n');const relevantTitle=[...context.unresolvedDilemmas,...context.recentDecisionDilemmas,...context.ongoingThreads].some(i=>i.title.length>=2&&query.includes(i.title));const continuing=(relevantSource||relevantTitle)&&(plan.intent==='help'||plan.intent==='recollection'||plan.intent==='relationship_repair'||plan.contextMessageIds.length>0);return {selected:plan.allowCharacterLifeMention||continuing,relevantTitle,relevantSource};}
const results=[];
for(const [text,expected] of [
 ['不用先听我说，直接给我建议。','help'],
 ['不是让你先听我说，是请你帮我分析。','help'],
 ['先听我说就好，不用建议。','venting'],
 ['请帮我分析这个问题。','help'],
 ['为什么我总把事情搞砸。','venting']]){
 const p=plan(text);results.push({case:'intent',text,expectedIntent:expected,actual:p,match:p.intent===expected});
}
const recent=[
{id:'m1',agentId:'a',sessionId:'s',role:'user',text:'以后聊工作时，请先听我说，不要急着给建议。'},
{id:'m2',agentId:'a',sessionId:'s',role:'user',text:'换个话题，昨晚和妹妹看了一部电影。'}];
const current='她说电影很好看，我也觉得挺有意思。';const p=plan(current,recent);
results.push({case:'scope_contamination',text:current,expandedQueries:p.expandedQueries,expectedWorkPracticeApplicable:false,currentOnlyMatch:matchesConversationTopic('工作',current),actualMatchOnSnapshotTopicText:matchesConversationTopic('工作',[current,...p.expandedQueries].join('\n'))});
const context={recentDecisions:[],recentDecisionDilemmas:[],activePressure:[],reflections:[],unresolvedDilemmas:[],ongoingThreads:[{title:'城市速写'}]};
for(const q of ['城市速写画得怎么样了？','你最近在忙什么？'])results.push({case:'life_followup',text:q,plan:plan(q),selection:selectLife(context,plan(q))});
const retractText='现在改一下，以后聊工作时可以直接给我建议。';
results.push({case:'practice_retraction_blocked',text:retractText,earlyReturnBecause:/(?:他说|她说|朋友说|假如|如果|假设|要是|[“”"「」]|今天|这次|现在|\b(?:if|said|today|this time)\b)/iu.test(retractText),note:'deriveExplicitPersonaPracticeRetractions returns [] before scope parsing because 现在 occurs.'});
console.log(JSON.stringify({commit:'780a7663582e4284202a8643492b7fd8ae37c87e',level:'isolated source predicate reproduction; not full-module/integration/real-API test',results},null,2));
