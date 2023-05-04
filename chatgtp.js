import cloud from '@lafjs/cloud'
import * as lark from '@larksuiteoapi/node-sdk'
var axios = require("axios");


const FEISHU_APP_ID = cloud.env.APP_ID || ""; // 飞书的应用 ID
const FEISHU_APP_SECRET = cloud.env.APP_SECRET || ""; // 飞书的应用的 Secret
const FEISHU_BOTNAME = cloud.env.BOTNAME || ""; // 飞书机器人的名字
const OPENAI_KEY = cloud.env.OPEN_API_SECRET || ""; // OpenAI 的 Key
const OPENAI_MODEL = cloud.env.MODEL || "gpt-3.5-turbo"; // 使用的模型
const OPENAI_MAX_TOKEN = cloud.env.MAX_TOKEN || 1024; // 最大 token 的值

// 获取数据库引用
const db = cloud.database()

// 初始化飞书
const client = new lark.Client({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  disableTokenCache: false,
});

// 回复消息
async function reply(messageId, content) {
  try {

    console.log("[reply] messageId : " , messageId)
    console.log("[reply] content : " , content)
    return await client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify({
          text: content,
        }),
        msg_type: "text",
      },
    });
  } catch (e) {
    console.log("[reply] send message to feishu error", e, messageId, content);
  }
}

// 获取openAI信息
async function buildConversation(sessionId: any, question: any) {
  let prompt = [];
  // 注释掉 历史会话信息 会消耗过多的token
  // const historyMsgs = await db.collection('user_msg').where({ session_id: sessionId }).field({ question: 1, answer: 1 }).get()

  // for (const conversation of historyMsgs.data) {
  //   prompt.push({ "role": "user", "content": conversation.question })
  //   prompt.push({ "role": "assistant", "content": conversation.answer })
  // }

  // 拼接最新 question
  prompt.push({ "role": "user", "content": question })
  return prompt;

}

// 通过 OpenAI API 获取回复
async function getOpenAIReply(prompt: any[]) {

  var data = JSON.stringify({
    model: OPENAI_MODEL,
    messages: prompt
  });

  var config = {
    method: "post",
    maxBodyLength: Infinity,
    url: "https://api.openai.com/v1/chat/completions",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    data: data,
    timeout: 50000
  };

  try {
    console.log("[getOpenAIReply] 通过 OpenAI API 获取回复...")
    const response = await axios(config);

    if (response.status === 429) {
      return '问题太多了，我有点眩晕，请稍后再试';
    }
    // 去除多余的换行
    return response.data.choices[0].message.content.replace("\n\n", "");

  } catch (e) {
    console.log("[getOpenAIReply] is error : ", e.response.data)
    return "问题太难了 出错了. (uДu〃).";
  }

}

// 保存用户会话
async function saveConversation(sessionId: any, question: string|any[], answer: string|any[]) {
  console.log("[saveConversation] sessionId : ", sessionId)
  const msgSize = question.length + answer.length
  const date = new Date();
  const timestamp = date.getTime();
  const result = await db.collection('user_msg').add({ "session_id": sessionId, "question": question, "answer": answer, "msgSize": msgSize, "create_at": timestamp});
  
  if (result.ok) {
    // 有历史会话是否需要抛弃 先不做抛弃,保留全部历史
    // await discardConversation(sessionId);
  }
}

// 如果历史会话记录大于OPENAI_MAX_TOKEN，则从第一条开始抛弃超过限制的对话
async function discardConversation(sessionId: any) {
  console.log("[discardConversation] sessionId : ", sessionId)
  let totalSize = 0;
  const countList = [];
  const historyMsgs = await db.collection('user_msg').where({ sessionId }).orderBy("create_at", "desc").get();
  const historyMsgLen = historyMsgs.data.length;
  for (let i = 0; i < historyMsgLen; i++) {
    const msgId = historyMsgs[i]._id;
    totalSize += historyMsgs[i].msgSize;
    countList.push({
      msgId,
      totalSize,
    });
  }
  for (const c of countList) {
    if (c.totalSize > OPENAI_MAX_TOKEN) {
      console.log("[discardConversation] msgId : ", c.msgId)
      await db.collection('user_msg').where({ _id: c.msgId }).remove();
    }
  }
}

// 处理消息内容
async function handleReply(userInput: { text: any; }, sessionId: any, messageId: any, eventId: any) {
  const question = userInput.text;
  console.log("[handleReply] question: " + question);
  const action = question.trim();
  const prompt = await buildConversation(sessionId, question);
  console.log("[handleReply] question: " + question);

  const openaiResponse = await getOpenAIReply(prompt);
  await saveConversation(sessionId, question, openaiResponse)
  await reply(messageId, openaiResponse);

  // update content to the event record
  await db.collection('event').add({ event_id: eventId, data: userInput, reply: openaiResponse })
  return { code: 0 };
}

export async function main(ctx: FunctionContext) {
  // const { ChatGPTAPI } = await import('chatgpt')

  const { body, response } = ctx
  console.log("[main] 请求参数:", JSON.stringify(body))

  // 处理飞书开放平台的服务端校验
  if (body.type === "url_verification") {
    console.log("[main] 认证url deal url_verification");
    response.json(body)
  }
  // 自检查逻辑
  if (body.check === 1) {
    console.log("[main] enter doctor");
    return await doctor();
  }
  // 处理飞书开放平台的事件回调
  if ((body.header.event_type === "im.message.receive_v1")) {
    let eventId = body.header.event_id;
    let messageId = body.event.message.message_id;
    let chatId = body.event.message.chat_id;
    let senderId = body.event.sender.sender_id.user_id;
    let sessionId = chatId + senderId;

    // 对于同一个事件，只处理一次
    const count = await db.collection('event').where({ event_id: eventId }).count()
    if (count.total != 0) {
      console.log("[main] skip repeat event");
      await reply(messageId, "该问题已回复请查看聊天记录~!");
      return { code: 1 };
    }

    // 私聊直接回复
    if (body.event.message.chat_type === "p2p") {
      // 不是文本消息，不处理
      if (body.event.message.message_type != "text") {
        await reply(messageId, "暂不支持其他类型的提问~!");
        console.log("[main] skip and reply not support");
        return { code: 0 };
      }
      // 是文本消息，直接回复
      const userInput = JSON.parse(body.event.message.content);
      return await handleReply(userInput, sessionId, messageId, eventId);
    }

  }

  response.json(body)
}


async function doctor() {
  if (FEISHU_APP_ID === "") {
    return {
      code: 1,
      message: {
        zh_CN: "你没有配置飞书应用的 AppID，请检查 & 部署后重试",
        en_US:
          "Here is no FeiSHu APP id, please check & re-Deploy & call again",
      },
    };
  }
  if (!FEISHU_APP_ID.startsWith("cli_")) {
    return {
      code: 1,
      message: {
        zh_CN:
          "你配置的飞书应用的 AppID 是错误的，请检查后重试。飞书应用的 APPID 以 cli_ 开头。",
        en_US:
          "Your FeiShu App ID is Wrong, Please Check and call again. FeiShu APPID must Start with cli",
      },
    };
  }
  if (FEISHU_APP_SECRET === "") {
    return {
      code: 1,
      message: {
        zh_CN: "你没有配置飞书应用的 Secret，请检查 & 部署后重试",
        en_US:
          "Here is no FeiSHu APP Secret, please check & re-Deploy & call again",
      },
    };
  }

  if (FEISHU_BOTNAME === "") {
    return {
      code: 1,
      message: {
        zh_CN: "你没有配置飞书应用的名称，请检查 & 部署后重试",
        en_US:
          "Here is no FeiSHu APP Name, please check & re-Deploy & call again",
      },
    };
  }

  if (OPENAI_KEY === "") {
    return {
      code: 1,
      message: {
        zh_CN: "你没有配置 OpenAI 的 Key，请检查 & 部署后重试",
        en_US: "Here is no OpenAI Key, please check & re-Deploy & call again",
      },
    };
  }

  if (!OPENAI_KEY.startsWith("sk-")) {
    return {
      code: 1,
      message: {
        zh_CN:
          "你配置的 OpenAI Key 是错误的，请检查后重试。OpenAI 的 KEY 以 sk- 开头。",
        en_US:
          "Your OpenAI Key is Wrong, Please Check and call again. FeiShu APPID must Start with cli",
      },
    };
  }
  return {
    code: 0,
    message: {
      zh_CN:
        "✅ 配置成功，接下来你可以在飞书应用当中使用机器人来完成你的工作。",
      en_US:
        "✅ Configuration is correct, you can use this bot in your FeiShu App",

    },
    meta: {
      FEISHU_APP_ID,
      OPENAI_MODEL,
      OPENAI_MAX_TOKEN,
      FEISHU_BOTNAME,
    },
  }

}
