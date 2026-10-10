package dsh.mirror.client.ui

import dsh.mirror.client.net.AskAnswer
import dsh.mirror.client.net.AskQuestion

/**
 * 提问卡的**纯逻辑**（抽出来是为了能单测：这段错了，答案会被宿主整批拒掉）。
 *
 * <p>宿主的规则（插件 `validateAnswers`）：一次提问里的每道题都要给一个答案，
 * 且每道题「要么选了选项、要么写了自定义答案」，否则回 400 `bad-answers` / `empty-answer`。
 */
object AskLogic {

    /** 能不能提交：每道题都至少有一个非空的选项或一句非空的自定义答案。 */
    fun ready(
        questions: List<AskQuestion>,
        selected: Map<String, List<String>>,
        custom: Map<String, String>,
    ): Boolean {
        if (questions.isEmpty()) return false
        return questions.all { q ->
            (selected[q.id]?.any { it.isNotBlank() } == true) || (custom[q.id]?.isNotBlank() == true)
        }
    }

    /** 组装这一批答案：**顺序跟着题目走**，空串一律丢掉。 */
    fun answers(
        questions: List<AskQuestion>,
        selected: Map<String, List<String>>,
        custom: Map<String, String>,
    ): List<AskAnswer> = questions.map { q ->
        AskAnswer(
            id = q.id,
            selected = (selected[q.id] ?: emptyList()).filter { it.isNotBlank() },
            custom = custom[q.id]?.takeIf { it.isNotBlank() },
        )
    }
}