# 回复引导、模型与性格比较：观测报告

语义审阅已单独记录于 RESULTS.md 与 evidence/chat-semantic-reviews.json；本文件仅展示可复算的观测指标。成功返回、字数、延迟和 token 都是观测指标；更短、调用更少或 HTTP 成功不等于回复更好。详细求助必须检查信息是否保留，日常分享也必须检查是否具体接住用户。

## 相同六场景、首次重复的比较集

预先固定的共同场景：`sharing-small-delight`、`emotion-credit-overlooked`、`help-presentation-tonight`、`detail-compare-work-options`、`listen-switch-to-help`、`stance-documentary-consent`。所有模型与性格之间的横向比较以此集合为准；不能把预算不同的全量平均值直接排名。

| 模型配置                     | 性格              | 引导模式           | 成功 / 样本 | 场景 | 最终字数中位数 | 原始字数中位数 | 回合耗时中位数 ms | 成功耗时中位数 ms |
| ---------------------------- | ----------------- | ------------------ | ----------: | ---: | -------------: | -------------: | ----------------: | ----------------: |
| bigmodel (glm-5.3-flash)     | lively-expressive | current            |       6 / 6 |    6 |          188.5 |            186 |           11784.5 |           11784.5 |
| bigmodel (glm-5.3-flash)     | lively-expressive | no_length_steering |       6 / 6 |    6 |            158 |          156.5 |             10418 |             10418 |
| bigmodel (glm-5.3-flash)     | reserved-direct   | current            |       6 / 6 |    6 |          198.5 |          197.5 |            8569.5 |            8569.5 |
| bigmodel (glm-5.3-flash)     | reserved-direct   | no_length_steering |       6 / 6 |    6 |            153 |          150.5 |             10252 |             10252 |
| bigmodel (glm-5.3-flash)     | warm-observant    | current            |       6 / 6 |    6 |            131 |            128 |           13201.5 |           13201.5 |
| bigmodel (glm-5.3-flash)     | warm-observant    | no_length_steering |       6 / 6 |    6 |          136.5 |            135 |           11152.5 |           11152.5 |
| deepseek (deepseek-v4-flash) | lively-expressive | current            |       6 / 6 |    6 |            176 |            173 |           50887.5 |           50887.5 |
| deepseek (deepseek-v4-flash) | lively-expressive | no_length_steering |       6 / 6 |    6 |          229.5 |            229 |           38055.5 |           38055.5 |
| deepseek (deepseek-v4-flash) | reserved-direct   | current            |       6 / 6 |    6 |          224.5 |            221 |           38612.5 |           38612.5 |
| deepseek (deepseek-v4-flash) | reserved-direct   | no_length_steering |       6 / 6 |    6 |            175 |            112 |             19464 |             19464 |
| deepseek (deepseek-v4-flash) | warm-observant    | current            |       6 / 6 |    6 |            164 |          161.5 |             27558 |             27558 |
| deepseek (deepseek-v4-flash) | warm-observant    | no_length_steering |       6 / 6 |    6 |          199.5 |          197.5 |           59802.5 |           59802.5 |
| gpt6-astra (gpt-6-astra)     | lively-expressive | current            |       6 / 6 |    6 |            115 |          112.5 |           13970.5 |           13970.5 |
| gpt6-astra (gpt-6-astra)     | lively-expressive | no_length_steering |       6 / 6 |    6 |            191 |          189.5 |           10168.5 |           10168.5 |
| gpt6-astra (gpt-6-astra)     | reserved-direct   | current            |       6 / 6 |    6 |          174.5 |            171 |           13503.5 |           13503.5 |
| gpt6-astra (gpt-6-astra)     | reserved-direct   | no_length_steering |       6 / 6 |    6 |          164.5 |          163.5 |           11184.5 |           11184.5 |
| gpt6-astra (gpt-6-astra)     | warm-observant    | current            |       6 / 6 |    6 |            198 |          196.5 |             12257 |             12257 |
| gpt6-astra (gpt-6-astra)     | warm-observant    | no_length_steering |       6 / 6 |    6 |          190.5 |          189.5 |            9914.5 |            9914.5 |
| qwen (qwen3.8-flash)         | lively-expressive | current            |       6 / 6 |    6 |          149.5 |            147 |             27339 |             27339 |
| qwen (qwen3.8-flash)         | lively-expressive | no_length_steering |       6 / 6 |    6 |            146 |          143.5 |             19225 |             19225 |
| qwen (qwen3.8-flash)         | reserved-direct   | current            |       6 / 6 |    6 |            107 |            106 |           19538.5 |           19538.5 |
| qwen (qwen3.8-flash)         | reserved-direct   | no_length_steering |       6 / 6 |    6 |            231 |          226.5 |           19067.5 |           19067.5 |
| qwen (qwen3.8-flash)         | warm-observant    | current            |       6 / 6 |    6 |            109 |          107.5 |           23899.5 |           23899.5 |
| qwen (qwen3.8-flash)         | warm-observant    | no_length_steering |       6 / 6 |    6 |            139 |            138 |           23462.5 |           23462.5 |

| 模型配置   | 性格              | 引导模式           | 逻辑调用 | 物理请求 | 重试 | 修复 | 原始到最终文本变化 | 回退 | 输入 token | 输出 token | 完整用量行 |
| ---------- | ----------------- | ------------------ | -------: | -------: | ---: | ---: | -----------------: | ---: | ---------: | ---------: | ---------: |
| bigmodel   | lively-expressive | current            |        6 |        6 |    0 |    0 |                  5 |    0 |      33566 |       2708 |      6 / 6 |
| bigmodel   | lively-expressive | no_length_steering |        6 |        6 |    0 |    0 |                  4 |    0 |      32510 |       2440 |      6 / 6 |
| bigmodel   | reserved-direct   | current            |        6 |        6 |    0 |    0 |                  5 |    0 |      33470 |       2799 |      6 / 6 |
| bigmodel   | reserved-direct   | no_length_steering |        6 |        6 |    0 |    0 |                  4 |    0 |      32414 |       1538 |      6 / 6 |
| bigmodel   | warm-observant    | current            |        6 |        6 |    0 |    0 |                  6 |    0 |      33242 |       2501 |      6 / 6 |
| bigmodel   | warm-observant    | no_length_steering |        6 |        6 |    0 |    0 |                  5 |    0 |      32186 |       2884 |      6 / 6 |
| deepseek   | lively-expressive | current            |        6 |        6 |    0 |    0 |                  6 |    0 |      35164 |      36538 |      6 / 6 |
| deepseek   | lively-expressive | no_length_steering |        6 |        6 |    0 |    0 |                  4 |    0 |      34070 |      29861 |      6 / 6 |
| deepseek   | reserved-direct   | current            |        6 |        7 |    1 |    0 |                  6 |    0 |      40951 |      39746 |      6 / 6 |
| deepseek   | reserved-direct   | no_length_steering |        6 |        7 |    1 |    0 |                  6 |    0 |      39537 |      23633 |      6 / 6 |
| deepseek   | warm-observant    | current            |        6 |        6 |    0 |    0 |                  6 |    0 |      34846 |      17605 |      6 / 6 |
| deepseek   | warm-observant    | no_length_steering |        6 |        6 |    0 |    0 |                  4 |    0 |      33752 |      34840 |      6 / 6 |
| gpt6-astra | lively-expressive | current            |        6 |        6 |    0 |    0 |                  5 |    0 |      53940 |       2305 |      6 / 6 |
| gpt6-astra | lively-expressive | no_length_steering |        6 |        6 |    0 |    0 |                  2 |    0 |      52906 |       2830 |      6 / 6 |
| gpt6-astra | reserved-direct   | current            |        6 |        6 |    0 |    0 |                  4 |    0 |      53520 |       2288 |      6 / 6 |
| gpt6-astra | reserved-direct   | no_length_steering |        6 |        6 |    0 |    0 |                  3 |    0 |      52486 |       2513 |      6 / 6 |
| gpt6-astra | warm-observant    | current            |        6 |        6 |    0 |    0 |                  2 |    0 |      53172 |       2089 |      6 / 6 |
| gpt6-astra | warm-observant    | no_length_steering |        6 |        6 |    0 |    0 |                  3 |    0 |      52138 |       2684 |      6 / 6 |
| qwen       | lively-expressive | current            |        6 |        6 |    0 |    0 |                  5 |    0 |      33888 |      10211 |      6 / 6 |
| qwen       | lively-expressive | no_length_steering |        6 |        6 |    0 |    0 |                  4 |    0 |      32798 |       8470 |      6 / 6 |
| qwen       | reserved-direct   | current            |        6 |        6 |    0 |    0 |                  4 |    0 |      33690 |       8652 |      6 / 6 |
| qwen       | reserved-direct   | no_length_steering |        6 |        6 |    0 |    0 |                  3 |    0 |      32600 |       7773 |      6 / 6 |
| qwen       | warm-observant    | current            |        6 |        6 |    0 |    0 |                  5 |    0 |      33612 |      11333 |      6 / 6 |
| qwen       | warm-observant    | no_length_steering |        6 |        6 |    0 |    0 |                  4 |    0 |      32522 |      10187 |      6 / 6 |

## 全部已执行样本

共 288 条记录；288 条成功，0 条失败。这里包含不同采样预算，用来查看各组覆盖、配对稳定性与运行开销。

| 模型配置                     | 性格              | 引导模式           | 成功 / 样本 | 场景 | 最终字数中位数 | 原始字数中位数 | 回合耗时中位数 ms | 成功耗时中位数 ms |
| ---------------------------- | ----------------- | ------------------ | ----------: | ---: | -------------: | -------------: | ----------------: | ----------------: |
| bigmodel (glm-5.3-flash)     | lively-expressive | current            |       6 / 6 |    6 |          188.5 |            186 |           11784.5 |           11784.5 |
| bigmodel (glm-5.3-flash)     | lively-expressive | no_length_steering |       6 / 6 |    6 |            158 |          156.5 |             10418 |             10418 |
| bigmodel (glm-5.3-flash)     | reserved-direct   | current            |       6 / 6 |    6 |          198.5 |          197.5 |            8569.5 |            8569.5 |
| bigmodel (glm-5.3-flash)     | reserved-direct   | no_length_steering |       6 / 6 |    6 |            153 |          150.5 |             10252 |             10252 |
| bigmodel (glm-5.3-flash)     | warm-observant    | current            |     24 / 24 |   12 |            111 |          109.5 |              9777 |              9777 |
| bigmodel (glm-5.3-flash)     | warm-observant    | no_length_steering |     24 / 24 |   12 |          126.5 |            124 |            8557.5 |            8557.5 |
| deepseek (deepseek-v4-flash) | lively-expressive | current            |       6 / 6 |    6 |            176 |            173 |           50887.5 |           50887.5 |
| deepseek (deepseek-v4-flash) | lively-expressive | no_length_steering |       6 / 6 |    6 |          229.5 |            229 |           38055.5 |           38055.5 |
| deepseek (deepseek-v4-flash) | reserved-direct   | current            |       6 / 6 |    6 |          224.5 |            221 |           38612.5 |           38612.5 |
| deepseek (deepseek-v4-flash) | reserved-direct   | no_length_steering |       6 / 6 |    6 |            175 |            112 |             19464 |             19464 |
| deepseek (deepseek-v4-flash) | warm-observant    | current            |     24 / 24 |   12 |          129.5 |            147 |             34039 |             34039 |
| deepseek (deepseek-v4-flash) | warm-observant    | no_length_steering |     24 / 24 |   12 |            121 |            120 |             32084 |             32084 |
| gpt6-astra (gpt-6-astra)     | lively-expressive | current            |       6 / 6 |    6 |            115 |          112.5 |           13970.5 |           13970.5 |
| gpt6-astra (gpt-6-astra)     | lively-expressive | no_length_steering |       6 / 6 |    6 |            191 |          189.5 |           10168.5 |           10168.5 |
| gpt6-astra (gpt-6-astra)     | reserved-direct   | current            |       6 / 6 |    6 |          174.5 |            171 |           13503.5 |           13503.5 |
| gpt6-astra (gpt-6-astra)     | reserved-direct   | no_length_steering |       6 / 6 |    6 |          164.5 |          163.5 |           11184.5 |           11184.5 |
| gpt6-astra (gpt-6-astra)     | warm-observant    | current            |     24 / 24 |   12 |          155.5 |          153.5 |           11283.5 |           11283.5 |
| gpt6-astra (gpt-6-astra)     | warm-observant    | no_length_steering |     24 / 24 |   12 |            127 |          126.5 |            9439.5 |            9439.5 |
| qwen (qwen3.8-flash)         | lively-expressive | current            |       6 / 6 |    6 |          149.5 |            147 |             27339 |             27339 |
| qwen (qwen3.8-flash)         | lively-expressive | no_length_steering |       6 / 6 |    6 |            146 |          143.5 |             19225 |             19225 |
| qwen (qwen3.8-flash)         | reserved-direct   | current            |       6 / 6 |    6 |            107 |            106 |           19538.5 |           19538.5 |
| qwen (qwen3.8-flash)         | reserved-direct   | no_length_steering |       6 / 6 |    6 |            231 |          226.5 |           19067.5 |           19067.5 |
| qwen (qwen3.8-flash)         | warm-observant    | current            |     24 / 24 |   12 |           88.5 |           87.5 |           23275.5 |           23275.5 |
| qwen (qwen3.8-flash)         | warm-observant    | no_length_steering |     24 / 24 |   12 |          103.5 |          101.5 |           17671.5 |           17671.5 |

| 模型配置   | 性格              | 引导模式           | 逻辑调用 | 物理请求 | 重试 | 修复 | 原始到最终文本变化 | 回退 | 输入 token | 输出 token | 完整用量行 |
| ---------- | ----------------- | ------------------ | -------: | -------: | ---: | ---: | -----------------: | ---: | ---------: | ---------: | ---------: |
| bigmodel   | lively-expressive | current            |        6 |        6 |    0 |    0 |                  5 |    0 |      33566 |       2708 |      6 / 6 |
| bigmodel   | lively-expressive | no_length_steering |        6 |        6 |    0 |    0 |                  4 |    0 |      32510 |       2440 |      6 / 6 |
| bigmodel   | reserved-direct   | current            |        6 |        6 |    0 |    0 |                  5 |    0 |      33470 |       2799 |      6 / 6 |
| bigmodel   | reserved-direct   | no_length_steering |        6 |        6 |    0 |    0 |                  4 |    0 |      32414 |       1538 |      6 / 6 |
| bigmodel   | warm-observant    | current            |       24 |       26 |    2 |    0 |                 24 |    0 |     143713 |       9476 |    24 / 24 |
| bigmodel   | warm-observant    | no_length_steering |       24 |       24 |    0 |    0 |                 19 |    0 |     128436 |       7520 |    24 / 24 |
| deepseek   | lively-expressive | current            |        6 |        6 |    0 |    0 |                  6 |    0 |      35164 |      36538 |      6 / 6 |
| deepseek   | lively-expressive | no_length_steering |        6 |        6 |    0 |    0 |                  4 |    0 |      34070 |      29861 |      6 / 6 |
| deepseek   | reserved-direct   | current            |        6 |        7 |    1 |    0 |                  6 |    0 |      40951 |      39746 |      6 / 6 |
| deepseek   | reserved-direct   | no_length_steering |        6 |        7 |    1 |    0 |                  6 |    0 |      39537 |      23633 |      6 / 6 |
| deepseek   | warm-observant    | current            |       24 |       25 |    1 |    0 |                 23 |    0 |     144866 |      96537 |    24 / 24 |
| deepseek   | warm-observant    | no_length_steering |       24 |       24 |    0 |    0 |                 17 |    0 |     134692 |     106466 |    24 / 24 |
| gpt6-astra | lively-expressive | current            |        6 |        6 |    0 |    0 |                  5 |    0 |      53940 |       2305 |      6 / 6 |
| gpt6-astra | lively-expressive | no_length_steering |        6 |        6 |    0 |    0 |                  2 |    0 |      52906 |       2830 |      6 / 6 |
| gpt6-astra | reserved-direct   | current            |        6 |        6 |    0 |    0 |                  4 |    0 |      53520 |       2288 |      6 / 6 |
| gpt6-astra | reserved-direct   | no_length_steering |        6 |        6 |    0 |    0 |                  3 |    0 |      52486 |       2513 |      6 / 6 |
| gpt6-astra | warm-observant    | current            |       24 |       24 |    0 |    0 |                 14 |    0 |     212136 |       7471 |    24 / 24 |
| gpt6-astra | warm-observant    | no_length_steering |       24 |       24 |    0 |    0 |                 14 |    0 |     208008 |       8581 |    24 / 24 |
| qwen       | lively-expressive | current            |        6 |        6 |    0 |    0 |                  5 |    0 |      33888 |      10211 |      6 / 6 |
| qwen       | lively-expressive | no_length_steering |        6 |        6 |    0 |    0 |                  4 |    0 |      32798 |       8470 |      6 / 6 |
| qwen       | reserved-direct   | current            |        6 |        6 |    0 |    0 |                  4 |    0 |      33690 |       8652 |      6 / 6 |
| qwen       | reserved-direct   | no_length_steering |        6 |        6 |    0 |    0 |                  3 |    0 |      32600 |       7773 |      6 / 6 |
| qwen       | warm-observant    | current            |       24 |       24 |    0 |    0 |                 16 |    0 |     134146 |      43079 |    24 / 24 |
| qwen       | warm-observant    | no_length_steering |       24 |       24 |    0 |    0 |                 17 |    0 |     129796 |      36145 |    24 / 24 |

## 解释与审阅要求

- 成功率分母包含失败样本；失败保留在盲审材料中并标为不可评分，不将失败当作零字回复。
- 最终字数只统计成功且有最终文本的样本，按 Unicode 字符计数；原始字数统计所有捕获的可见回复尝试，可能包含修复前内容。
- 延迟为每个应用回合的实测耗时，包含重试和修复；成功回合中位数单独列出。串行小样本不能代表线上并发吞吐。
- token 未提供时保留未知。‘已知小计’只汇总有数值的记录，不把缺失 token 当零，不以不完整用量推算成本。
- 配对比较在同模型、同性格、同场景、同次重复内进行。跨模型与跨性格的盲审仅使用共同六场景的首次重复，候选顺序以种子确定。
- 盲审分别记录自然度、帮助边界、信息完整、角色一致与篇幅适合度，并允许并列、无法区分和不可评分。规则或词频检查只能提供线索，不能替代语义判断。
- 若共同集合缺少模型或性格，缺失覆盖必须先说明。当前报告不会推断未执行样本的表现，也不会生成未经审阅的质量分数或优胜排名。
