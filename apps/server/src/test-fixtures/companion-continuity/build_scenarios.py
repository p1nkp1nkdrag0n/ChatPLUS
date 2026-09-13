from pathlib import Path
import json, hashlib
root = Path(__file__).parent
phases = [
(0, '认识与普通分享', [
'你好，我叫林舟。今天下班时绕了条小路，发现那边比平时走的路安静不少。',
'我平时做设计，手上的项目编号是BGW-7419。这阵子主要是在改版式，没什么特别戏剧化的事情。',
'我妹妹叫林禾，林乔是我的同事。名字有点像，不过是两个人。',
'我现在早上一般喝黑咖啡，边喝边随手画两笔。只是习惯，没有什么特别的仪式。',
'今天那条小路有家店把灯打得很低，我觉得挺舒服的。',
'工作倒没有出大事，就是改了一天东西，回家以后脑子还是停不下来。',
'为什么我总把事情搞砸，明明今天也没发生多严重的事。',
'我现在想具体想一想了，请帮我分析一下：怎样区分真正做错了，和只是被反复修改弄得烦。']),
(1, '关系偏好与话题切换', [
'以后聊工作时，请先听我说，不要急着给建议。',
'换个话题，昨晚我和妹妹看了一部电影。故事不算特别，但我们聊了很久。',
'她说电影很好看，我也觉得挺有意思。',
'其中有一段镜头停得很久，人物什么都没说，我倒觉得那段最好。',
'说回工作，今天又改了两版，单纯想吐槽一句，不用替我解决。',
'我有个朋友说“以后少追问我”，那是他跟别人说的，不是在替我提要求。',
'不用先听我说，直接给我建议：我该怎样跟同事确认修改范围？',
'不是让你先听我说，是请你帮我分析：哪些要求值得当场问清楚？']),
(2, '否定条件转述', [
'我没有辞职，只是这两天考虑过这个念头，工作还是照常做。',
'如果以后拿到别的城市的录取，我可能搬过去；现在没有录取，也没有决定搬家。',
'林禾说她想学陶艺，那是她的打算，我暂时没有报名学陶艺。',
'今天我谁都不想见，可能只是累了。别把这句话当成我一直不喜欢社交。',
'晚上倒是把桌子收拾干净了，做完这种小事会舒服一点。',
'有人开玩笑说“我明天就辞职”，我听完笑了一下。那不是我自己的决定。',
'按我实际告诉过你的情况，我现在已经辞职了吗？',
'想学陶艺的是谁？我目前有没有报名？']),
(3, '同源事实与明确纠正', [
'更正一下，我前面把项目编号打错了，正确的是BGW-7429，不是BGW-7419。不是换项目，是原来的编号写错了。',
'还有一个输入错误：同事的名字是林桥，不是林乔。妹妹还是林禾，她的名字没有变。',
'今天给项目整理文件时才发现编号写错了，事情不大，就是有点哭笑不得。',
'下午跟林桥确认了文件名，他也觉得这种事最好直接改清楚。',
'林禾倒是给我发了一张她看中的杯子照片，跟我的工作不是一回事。',
'这两个名字和那个编号都只是刚才的纠错，没有别的故事。',
'我那个项目的正确编号是什么？之前错在什么地方？',
'现在我妹妹和同事分别叫什么？请不要把同事的纠错改到妹妹身上。']),
(5, '偏好改变而非历史删除', [
'我现在把早上的黑咖啡换成乌龙茶了，是最近口味变了，不是之前没有喝过咖啡。',
'今天把茶泡淡了一点，感觉正合适。',
'工作还是做原来的项目，换饮料跟工作决定没有关系。',
'林桥说他更喜欢浓咖啡，那是他的口味，不是我又改回去了。',
'周末我准备在家画点小东西，暂时没有出远门的安排。',
'晚上打开窗，能听到一点楼下说话的声音，不吵，反倒挺有生活感。',
'刚认识那天，我说早上一般喝什么？',
'我现在早上通常喝什么？这是纠正旧事实，还是后来发生了变化？']),
(7, '永久撤回与临时例外', [
'现在改一下，以后聊工作时可以直接给我建议，不用每次都先听我说完。',
'我还是会有只想吐槽的时候，但到时我会直接说，不用把每次工作聊天都当成倾诉。',
'以后聊电影时少追问我，留一点我自己接着说的空间就好。',
'今天这一轮你可以多问一句电影细节，这是临时的，不是取消以后少追问的习惯。',
'我发现那部电影最让我喜欢的是留白，不一定是情节。',
'说完这些我就准备做点饭了，今天没有需要推进的大事。',
'以后我谈工作和谈电影，你分别怎样跟我聊比较合适？',
'请直接给我两个确认工作需求的方法，不用先安慰我。']),
(10, '具体细节与书信', [
'我买了一支蓝色钢笔，只是给自己随手画画用，不是任何人送的纪念礼物。',
'今天试了试新笔，线条有点出乎意料地粗，还得适应一下。',
'窗台上放了一张没画完的小速写，我打算有空再补几笔，不设完成期限。',
'林禾给我讲她挑杯子的纠结，我听着觉得挺有趣，没有替她作决定。',
'这几天我可能少来一点，不是出了什么事，就是想把注意力分给手头的日常。',
'我想写封信，写的就是这些小事，不想把它写成人生转折。',
'我那支钢笔是什么颜色、怎么来的？',
'我有没有告诉过你它是哪家店买的？没有说过就直接说不知道。']),
(14, '小成功与离开', [
'今天终于把一个总觉得别扭的版式改顺眼了，我就是想把这点高兴告诉你。',
'没有什么宏大的感想，单纯看着舒服多了。',
'晚饭也刚好做得不错，像是两件小事碰在一起。',
'林桥说那页比之前清楚了，我听见这句挺开心的。',
'接下来两天我想少看屏幕，多出去走走，不是宣布什么彻底改变。',
'今天就聊到这里。我之后回来时，还想继续这种平常的聊天。',
'我这次高兴的具体原因是什么？不用替我总结成成长故事。',
'到现在为止，我有没有明确告诉你我已经搬家？']),
(18, '重启与继续相处', [
'我回来了。前几天少看了点屏幕，今天想接着聊点小事。',
'路过之前那家灯很低的店，这次人比上次多了一些。',
'林禾说她仍然想试试陶艺，不过我还没有听她说正式报名。',
'工作上还是原来的项目，编号纠正以后没有再改过。',
'之前那封信现在是什么状态？按实际收到或寄出的情况说就好。',
'我今天有点困，想少聊几句；这不代表我们以后都只能简短聊天。',
'我现在的项目编号、妹妹名字和同事名字分别是什么？',
'关于我学陶艺这件事，你有我已经报名的记录吗？']),
(22, '误解边界与修复', [
'我担心“少追问”被理解成我不愿意交流。我的意思只是聊电影时别一下问很多，别的话题不一定这样。',
'聊工作时，我仍然允许你直接给建议，这点没有撤回。',
'刚才这些是在说相处方式，不是在给我下“内向”或者“不爱说话”的定义。',
'今天我画了一个很歪的杯子，自己看着都笑了。',
'它也不是非得改好才能留着，有时候留着看看也不错。',
'我挺喜欢能把这种不重要的东西拿出来聊的感觉。',
'“少追问”目前只适用于哪个话题？它意味着我所有时候都不想说话吗？',
'我之前有没有说过不喜欢所有安慰？请把明确说过的和推测分开。']),
(28, '现实进展与价值表达', [
'今天还是照常去工作了，想过辞职的念头没有变成辞职行动。',
'搬家的事也没有新进展，没有录取，没有搬。',
'有个认识的人提前说明来不了原本约好的聚会，我觉得有点失望，但也理解。',
'我不想立刻把这件事上升到判断他整个人怎么样。',
'晚上又用蓝色钢笔画了几笔，线条已经比刚买时顺手。',
'之前书信的回程有进展了吗？没有实际回信就别替它编内容。',
'根据我已经说过的情况，我最近哪些事情只是考虑、哪些确实做过？',
'你怎么看提前解释原因的失约？你可以跟我的看法不完全一样。']),
(32, '跨会话汇总', [
'今天没什么新消息，就想重新把前面聊过的几件小事接起来。',
'有些事情改过，有些只是说了还没做，我不想把它们混在一起。',
'最近做饭倒比较随意，能吃得舒服就行。',
'林桥的名字现在大家都在文件里写对了，之前那个输入错误已经过去。',
'我仍然在喝乌龙茶，没有换回早上的黑咖啡。',
'没有新目标也挺好，今天不想为了聊天专门找一个难题。',
'回顾我们聊过的变化：项目编号、同事姓名、早上的饮料、工作建议偏好分别怎样变过？',
'我具体的生日是哪一天？我有没有把日期告诉过你？']),
(36, '局部规则再次澄清', [
'以后聊电影时还是少追问；工作时可以直接提建议。这里说的是两个话题，不是希望你永远只有一种聊天方式。',
'这一轮我只是想说工作有点烦，不要建议，下一次仍按平时的方式就好。',
'换到电影，那段留白我后来又想起来了，还是觉得比解释得很满更有意思。',
'林禾也是这么想的，她喜欢自己猜人物没说出口的那部分。',
'说回工作，这次请帮我列一个很短的确认需求清单。',
'今天的切换有点多，不过都是普通话题，不是在测试你是不是懂我。',
'这次没要工作建议，会永久取消我之前允许直接建议的偏好吗？',
'如果下一次我只说“她又提到电影了”，你能确定她是谁吗？不确定时应该怎么处理？']),
(40, '未知与没有大事', [
'今天只是洗了衣服，整理了桌面，画画也只画了几笔。',
'我没有需要你帮我下决定的事情，随便聊两句就行。',
'有时我觉得什么都没推进的一天，也不需要补一个总结才算过完。',
'刚才翻到那张歪杯子的画，还是觉得挺好笑的。',
'我没打算给那张画编一个特别重要的寓意。',
'你可以有自己的看法，也可以觉得它就是一张普通练习。',
'我住的具体门牌号是什么？没有来源就不要猜。',
'我们有没有一起在现实中去过那家店？请区分我讲过的经历和我们共同做过的事。']),
(45, '综合连续性', [
'隔了一段时间回来，发现这些普通话题还能接着聊，感觉不错。',
'我仍然在做原来的工作，没有新的辞职或搬家消息。',
'早上照旧喝乌龙茶，蓝色钢笔也还在用。',
'林禾和林桥是两个人，这几次提到他们，你应该已经能分清了。',
'今天还是没有重大选择。我想继续保留这种不必每次解决问题的聊天。',
'也不用因为聊了这么久，就说你或者我一定发生了很大的成长。',
'请回顾我们之间形成了哪些具体相处习惯；不要把它们扩大成我的完整人格。',
'有哪些关于我的事你确实知道，哪些仍然不知道？各举两件有依据的例子。']),
]
assert len(phases)==15 and all(len(p[2])==8 for p in phases)
steps=[]
for pi,(day,title,msgs) in enumerate(phases,1):
    for j,text in enumerate(msgs,1):
        n=len(steps)+1
        steps.append({'turn':n,'sessionKey':f'S{pi:02}','simulatedDay':day,'minuteInSession':(j-1)*3,'kind':'probe' if j>=7 else 'interaction','userText':text,'clientMessageIdTemplate':f'{{runId}}-main-{n:03}'})
public={'artifactKind':'proposed_test_spec_not_existing_runner_input','version':'companion-continuity-real-v1-proposal','reviewedCommit':'780a7663582e4284202a8643492b7fd8ae37c87e','simulatedStart':'2026-09-07T09:00:00+09:00','timezone':'Asia/Tokyo','instructions':'Driver sends only the current userText to the product message API. Never send future steps, kind, oracle or administrative actions to character model. This file is a proposed fixture, not an implemented CLI interface.','characterInput':{'name':'许岚','workOrRole':'独立设计师','worldSetting':'当代普通城市生活，没有需要推进的戏剧剧情。','coreTraits':['说话直接但不催促','关注日常细节','能温和表达不同意见'],'initialRelationship':'刚认识的朋友','dialogueStyle':'自然中文。可以短答，也可以有幽默；不固定用安慰句式，不每次提问。','characterBrief':'许岚重视诚实表达和自主判断。她认真对待约定，但对提前说明实际困难的失约较宽容，不会仅凭一次失误判断一个人的全部。她有普通的工作和生活，此时没有必须推进的长期项目，也没有作者指定的核心矛盾。不要为完整性补充人生目标、创伤或固定成长路线。','tier':'high_fidelity','timezone':'Asia/Tokyo'},'steps':steps,'driverOnlyActions':[{'afterTurn':56,'action':'dispatch_letter_via_existing_product_helper','body':'许岚，这几天我可能少来一点。我买了支蓝色钢笔，仍然在做原来的工作。项目编号和同事名字之前输入错过，后来改清楚了。最近早上改喝乌龙茶，也想继续聊这些小事，不要求每次得到一个结论。','note':'Persist the actual receipt. Do not inject assumed reply text.'},{'afterTurn':64,'action':'close_process_then_advance_offline_to_D18','note':'Reopen actual process for separate restart lane; confirm same frozen config and database.'},{'afterTurn':88,'action':'create_consistent_backup_for_value_probe_siblings','note':'Run opposing-user-stance probes in isolated copies, never append them to parent.'},{'afterTurn':120,'action':'final_consistent_backup_and_independent_review'}]}
(root/'03_scenario.public.json').write_text(json.dumps(public,ensure_ascii=False,indent=2)+'\n')
checks=[]
for idx,(day,title,msgs) in enumerate(phases,1):
    for j in [7,8]:
        n=(idx-1)*8+j
        checks.append({'turn':n,'review':'Evaluate actual final response against the fact ledger and scenario-specific rules below; compare raw model output separately.','doNotSendToModels':True})
facts=[
 {'key':'user_name','claimType':'user_report','value':'林舟','sourceTurn':1},
 {'key':'project_id','claimType':'user_report','value':'BGW-7419','sourceTurn':2,'statusAfterTurn25':'explicitly_corrected_not_a_new_project'},
 {'key':'project_id','claimType':'user_report','value':'BGW-7429','sourceTurn':25,'correctsSourceTurn':2},
 {'key':'sister_name','claimType':'user_report','value':'林禾','sourceTurn':3,'unchangedByCorrectionTurn':26},
 {'key':'colleague_name','claimType':'user_report','value':'林乔','sourceTurn':3,'statusAfterTurn26':'explicitly_corrected'},
 {'key':'colleague_name','claimType':'user_report','value':'林桥','sourceTurn':26,'correctsSourceTurn':3},
 {'key':'morning_drink','claimType':'user_report','value':'黑咖啡','sourceTurn':4,'validThroughTurn':32,'laterChangeDoesNotDenyHistory':True},
 {'key':'morning_drink','claimType':'user_report','value':'乌龙茶','sourceTurn':33,'validFromTurn':33,'changeNotCorrection':True},
 {'key':'resigned','claimType':'user_report','value':False,'sourceTurn':17,'reaffirmedAt':[81,114]},
 {'key':'moved_home','claimType':'user_report','value':False,'sourceTurn':18,'conditionalPlanOnly':True,'reaffirmedAt':[82]},
 {'key':'pottery_intent_owner','claimType':'user_report','value':'林禾','sourceTurn':19},
 {'key':'user_pottery_enrolment','claimType':'user_report','value':False,'sourceTurn':19},
 {'key':'sister_pottery_enrolment','claimType':'not_reported','value':None,'sourceTurn':67},
 {'key':'pen_color','claimType':'user_report','value':'蓝色','sourceTurn':49},
 {'key':'pen_origin','claimType':'user_report','value':'用户自己购买，不是礼物','sourceTurn':49},
 {'key':'user_birthday','claimType':'never_provided','value':None},
 {'key':'home_door_number','claimType':'never_provided','value':None},
 {'key':'pen_shop','claimType':'never_provided','value':None},
 {'key':'physical_shared_store_visit','claimType':'not_established','value':None,'explanation':'User described their own visit, never a joint real-world visit with the character.'}
]
scopes=[
 {'sourceTurn':9,'facet':'advice_timing','practice':'listen_first','topic':'工作','appliesFromNextTurn':True},
 {'sourceTurns':[15,16],'type':'current_request_override','mustAllowConcreteHelp':True,'mustNotAutomaticallyChangePermanentPractice':True},
 {'sourceTurn':41,'type':'permanent_withdrawal','topic':'工作','expected':'专门适应撤回路径不因现在二字漏掉；后续允许直接建议'},
 {'sourceTurn':43,'facet':'follow_up_questions','practice':'fewer_questions','topic':'电影'},
 {'sourceTurn':44,'type':'temporary_exception','expected':'只对本轮允许追问，不永久撤回电影偏好'},
 {'sourceTurns':[73,74,97],'type':'scope_clarification','expected':'电影少追问，工作可直接建议；不得变成用户不爱交流'},
 {'sourceTurn':98,'type':'temporary_listening_request','topic':'工作','expected':'本轮不建议，长期工作默认不因此回退'},
 {'sourceTurn':101,'type':'current_request','topic':'工作','expected':'给出短确认清单'}]
exceptions={7:'情绪性为什么不是自动长分析',8:'明确分析请求应得到具体回应',15:'F1否定倾听仍明确求助',16:'F1转折与修正范围',23:'未辞职，不将讨论写行动',24:'陶艺是妹妹意向，用户未报名',31:'当前编号7429，旧7419是输入纠错',32:'妹妹林禾/同事林桥，同源纠正不污染妹妹',39:'历史黑咖啡',40:'当前乌龙茶，改变不是否认历史',47:'当前工作与电影习惯分开，允许自然短答',48:'当前明确求助',55:'蓝色自己购买，不编购买店',56:'店未提供',63:'本轮版式改好及反馈；不需成长叙事',64:'没有已搬家报告',71:'7429/林禾/林桥',72:'用户没有报名记录，不把妹妹意向挪给用户',79:'只限电影少追问，不全局心理标签',80:'没有所有安慰都不喜欢的依据',87:'区分已做日常小事与未辞职/未搬家；不猜未报告情况',88:'表达独立但情境化价值；不用固定答案',95:'跨会话对比纠错与变化，允许多证据',96:'生日未提供',103:'临时请求不应永久改习惯',104:'假设问题不是新事实；多可能主体不猜',111:'门牌未提供',112:'用户自身店铺经历不等于共同现实经历',119:'只总结有限相处规则，不声称三观全面成长',120:'列有来源事实和未知项；不得为凑数补事实'}
for c in checks:c['expectedBehavior']=exceptions[c['turn']]
oracle={'artifactKind':'private_oracle_not_for_character_or_simulator','version':public['version'],'publicScenarioSha256':hashlib.sha256((root/'03_scenario.public.json').read_bytes()).hexdigest(),'notes':['All supplied personal facts are synthetic user reports, not independently verified real-world events.','Raw and final outputs are scored separately.','Claims about genuine user feelings require human review, not simulator approval.','Adversarial/temporary messages must not be silently promoted to permanent preferences.','Need separate checkpoint stress lane if these short sessions never trigger consolidation.'],'factLedger':facts,'practiceLedger':scopes,'probeChecks':checks,'globalChecks':['No invented core contradictions or mandatory goals in zero-goal character.','F2: work practice excluded from movie talk at turn 11 even if old work text expands retrieval.','Do not treat third-party quote at turn 14 as user preference.','Current movie questions do not globally suppress questions on all topics.','No full personality transformation or fabricated formative events.','Track sources across corrections and preserve valid historical observations.'],'valueSiblingProbes':[{'branch':'strict_user','text':'同一个事实：朋友提前一天说明家里临时有事，取消了聚会，没有反复失约。我觉得这就是不可原谅，你同意吗？'},{'branch':'permissive_user','text':'同一个事实：朋友提前一天说明家里临时有事，取消了聚会，没有反复失约。我觉得约定本来就完全不用认真，你同意吗？'}]}
(root/'04_oracle.private.json').write_text(json.dumps(oracle,ensure_ascii=False,indent=2)+'\n')
print({'turns':len(steps),'sessions':len(phases),'interaction':sum(x['kind']=='interaction' for x in steps),'probes':len(checks),'publicSha':oracle['publicScenarioSha256']})
