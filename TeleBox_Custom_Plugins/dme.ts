/**
 * DME (Delete My Messages) Plugin for TeleBox
 * 智能防撤回删除插件 - 全局防撤回版
 *
 * 修改点：默认开启防撤回模式，移除 -f 参数，所有操作均尝试替换媒体。
 *
 * 功能：
 * 1. .dme [数量] : 防撤回删除最近 N 条自己的消息
 * 2. 回复某条消息 + .dme : 防撤回删除被回复的那一条消息（仅限自己的）
 * 3. 回复某条消息 + .dme -r : 防撤回删除从该消息开始的所有后续消息（仅限自己的）
 */

import { TelegramClient, Api } from 'teleproto'
import { getGlobalClient } from '@utils/globalClient'
import { getEntityWithHash } from '@utils/entityHelpers'
import { Plugin } from '@utils/pluginBase'
import { CustomFile } from 'teleproto/client/uploads'
import * as fs from 'fs'
import * as path from 'path'

// 常量配置
const CONFIG = {
  TROLL_IMAGE_URL: 'https://raw.githubusercontent.com/TeleBoxDev/TeleBox/main/telebox.png',
  TROLL_IMAGE_PATH: './assets/dme/dme_troll_image.png',
  BATCH_SIZE: 50,
  MIN_BATCH_SIZE: 5,
  MAX_BATCH_SIZE: 100,
  RETRY_ATTEMPTS: 3,
  DELAYS: {
    BATCH: 200,
    EDIT_WAIT: 1000,
    SEARCH: 100,
    RETRY: 2000,
    NETWORK_ERROR: 5000
  }
} as const

// 工具函数
const htmlEscape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (m) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;'
      })[m] || m
  )

const prefixes = ['.']
const mainPrefix = prefixes[0]

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 获取防撤回图片，支持缓存
 */
async function getTrollImage(): Promise<string | null> {
  if (fs.existsSync(CONFIG.TROLL_IMAGE_PATH)) {
    return CONFIG.TROLL_IMAGE_PATH
  }

  const dir = path.dirname(CONFIG.TROLL_IMAGE_PATH)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  try {
    const response = await fetch(CONFIG.TROLL_IMAGE_URL)
    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer())
      fs.writeFileSync(CONFIG.TROLL_IMAGE_PATH, buffer)
      return CONFIG.TROLL_IMAGE_PATH
    }
    return null
  } catch (error) {
    console.error('[DME] 下载防撤回图片失败:', error)
    return null
  }
}

/**
 * 核心：处理一批消息（先尝试编辑媒体，然后删除）
 * 这是所有删除操作的统一入口
 */
async function processBatchWithAntiRecall(client: TelegramClient, chatEntity: any, messages: Api.Message[]): Promise<{ deleted: number; edited: number }> {
  if (!messages || messages.length === 0) return { deleted: 0, edited: 0 }

  let editedCount = 0
  const trollImagePath = await getTrollImage()

  // 1. 筛选出需要编辑的媒体消息
  const mediaMessages = messages.filter((m: Api.Message) => {
    // 排除网页预览
    if (!m.media || m.media instanceof Api.MessageMediaWebPage) return false
    // 排除贴纸
    if (m.media instanceof Api.MessageMediaDocument) {
      const doc = m.media.document
      if (doc instanceof Api.Document) {
        const isSticker = doc.attributes?.some((attr) => attr instanceof Api.DocumentAttributeSticker)
        if (isSticker) return false
      }
    }
    return true
  })

  // 2. 并发执行编辑操作
  if (mediaMessages.length > 0 && trollImagePath) {
    console.log(`[DME] 正在处理 ${mediaMessages.length} 条媒体消息...`)
    const editPromises = mediaMessages.map((msg: Api.Message) => editMediaMessageToAntiRecall(client, msg, trollImagePath, chatEntity).catch(() => false))

    const results = await Promise.allSettled(editPromises)
    editedCount = results.filter((r) => r.status === 'fulfilled' && r.value === true).length

    if (editedCount > 0) {
      await sleep(CONFIG.DELAYS.EDIT_WAIT) // 等待编辑生效
    }
  }

  // 3. 批量删除所有消息（包括刚刚编辑过的和纯文本）
  const deleteIds = messages.map((m) => m.id)
  const deleteResult = await adaptiveBatchDelete(client, chatEntity, deleteIds)

  return { deleted: deleteResult.deletedCount, edited: editedCount }
}

/**
 * 媒体消息防撤回处理的具体实现
 */
async function editMediaMessageToAntiRecall(client: TelegramClient, message: Api.Message, trollImagePath: string | null, chatEntity: any): Promise<boolean> {
  if (!trollImagePath || !fs.existsSync(trollImagePath)) return false

  // 超过可编辑时间窗口(48h)则跳过
  const nowSec = Math.floor(Date.now() / 1000)
  if (typeof (message as any).date === 'number' && nowSec - (message as any).date > 172800) {
    return false
  }

  try {
    const uploadedFile = await client.uploadFile({
      file: new CustomFile('dme_troll.jpg', fs.statSync(trollImagePath).size, trollImagePath),
      workers: 1
    })

    await client.invoke(
      new Api.messages.EditMessage({
        peer: chatEntity,
        id: message.id,
        message: '', // 清空文字
        media: new Api.InputMediaUploadedPhoto({ file: uploadedFile })
      })
    )
    return true
  } catch {
    return false
  }
}

/**
 * 基础删除功能：带重试和自适应批次
 */
async function deleteMessagesWithRetry(client: TelegramClient, chatEntity: any, messageIds: number[], retryCount: number = 0): Promise<number> {
  if (messageIds.length === 0) return 0
  try {
    await client.deleteMessages(chatEntity, messageIds, { revoke: true })
    // 尝试触发同步
    try {
      await client.invoke(new Api.updates.GetState())
    } catch {}
    return messageIds.length
  } catch (error: any) {
    if (retryCount < CONFIG.RETRY_ATTEMPTS) {
      await sleep(CONFIG.DELAYS.RETRY * (retryCount + 1))
      return deleteMessagesWithRetry(client, chatEntity, messageIds, retryCount + 1)
    }
    throw error
  }
}

async function adaptiveBatchDelete(client: TelegramClient, chatEntity: any, messageIds: number[]): Promise<{ deletedCount: number; failedCount: number }> {
  if (messageIds.length === 0) return { deletedCount: 0, failedCount: 0 }

  let deletedCount = 0
  let failedCount = 0
  let currentBatchSize: number = CONFIG.BATCH_SIZE

  for (let i = 0; i < messageIds.length; i += currentBatchSize) {
    const batch = messageIds.slice(i, i + currentBatchSize)
    try {
      const deleted = await deleteMessagesWithRetry(client, chatEntity, batch)
      deletedCount += deleted
      if (currentBatchSize < CONFIG.MAX_BATCH_SIZE) currentBatchSize += 10
      await sleep(CONFIG.DELAYS.BATCH)
    } catch (error: any) {
      failedCount += batch.length
      if (currentBatchSize > CONFIG.MIN_BATCH_SIZE) currentBatchSize = Math.max(5, Math.floor(currentBatchSize / 2))
      if (error.message?.includes('FLOOD')) await sleep(CONFIG.DELAYS.NETWORK_ERROR)
      else await sleep(CONFIG.DELAYS.RETRY)
    }
  }
  return { deletedCount, failedCount }
}

/**
 * 范围删除模式 (回复 + -r) - 默认防撤回
 */
async function deleteRangeMessages(client: TelegramClient, chatEntity: any, myId: bigint, startMessageId: number): Promise<{ processedCount: number; editedCount: number }> {
  console.log(`[DME] 启动范围防撤回删除，起始ID: ${startMessageId}`)

  let totalProcessed = 0
  let totalEdited = 0
  let batchMessages: Api.Message[] = []

  // 遍历历史消息
  for await (const message of client.iterMessages(chatEntity, {
    minId: startMessageId - 1
  })) {
    if (message.senderId?.toString() === myId.toString()) {
      batchMessages.push(message)

      // 攒够一批处理一批
      if (batchMessages.length >= CONFIG.BATCH_SIZE) {
        const result = await processBatchWithAntiRecall(client, chatEntity, batchMessages)
        totalProcessed += result.deleted
        totalEdited += result.edited
        batchMessages = [] // 清空批次
      }
    }
  }

  // 处理剩余的消息
  if (batchMessages.length > 0) {
    const result = await processBatchWithAntiRecall(client, chatEntity, batchMessages)
    totalProcessed += result.deleted
    totalEdited += result.edited
  }

  return { processedCount: totalProcessed, editedCount: totalEdited }
}

/**
 * 流式搜索并处理 (用于 .dme [数量]) - 默认防撤回
 */
async function streamSearchAndProcess(client: TelegramClient, chatEntity: any, myId: bigint, userRequestedCount: number): Promise<{ processedCount: number; editedCount: number }> {
  console.log(`[DME] 启动流式防撤回处理，目标: ${userRequestedCount}`)

  const targetCount = userRequestedCount === 999999 ? Infinity : userRequestedCount
  let totalProcessed = 0
  let totalEdited = 0
  let offsetId = 0
  let consecutiveEmptyBatches = 0

  // 决定每批获取多少条历史记录进行扫描
  const SCAN_BATCH_SIZE = 100

  while (totalProcessed < targetCount && consecutiveEmptyBatches < 3) {
    try {
      const history = await client.invoke(
        new Api.messages.GetHistory({
          peer: chatEntity,
          offsetId,
          limit: SCAN_BATCH_SIZE
        })
      )

      const msgs = (history as any).messages || []
      const validMsgs = msgs.filter((m: any) => m.className === 'Message')

      if (validMsgs.length === 0) break

      // 筛选自己的消息
      const myMessages = validMsgs.filter((m: any) => m.senderId?.toString() === myId.toString() || m.out === true)

      if (myMessages.length === 0) {
        offsetId = validMsgs[validMsgs.length - 1].id
        consecutiveEmptyBatches++
        await sleep(CONFIG.DELAYS.SEARCH)
        continue
      }

      consecutiveEmptyBatches = 0

      // 截取当前需要的数量
      const remainingNeeded = targetCount === Infinity ? Infinity : targetCount - totalProcessed
      const msgsToProcess = myMessages.slice(0, remainingNeeded)

      // 核心处理：编辑 -> 删除
      const result = await processBatchWithAntiRecall(client, chatEntity, msgsToProcess)

      totalProcessed += result.deleted
      totalEdited += result.edited

      if (totalProcessed >= targetCount) break

      offsetId = validMsgs[validMsgs.length - 1].id
      await sleep(CONFIG.DELAYS.SEARCH)
    } catch (e) {
      console.error('[DME] 流式处理出错:', e)
      consecutiveEmptyBatches++
      await sleep(CONFIG.DELAYS.RETRY)
    }
  }

  return { processedCount: totalProcessed, editedCount: totalEdited }
}

// 帮助文本
const help_text = `🗑️ <b>智能防撤回删除插件</b> (默认防撤回版)

<b>所有操作默认开启防撤回模式（先替换媒体后删除）。</b>

<b>指令说明：</b>
• <code>${mainPrefix}dme [数量]</code> 
  删除最近 N 条自己的消息。
  
• <b>回复消息</b> + <code>${mainPrefix}dme</code>
  删除被回复的那一条消息。

• <b>回复消息</b> + <code>${mainPrefix}dme -r</code>
  删除从该消息开始，直到最新的所有消息（范围删除）。

<b>示例：</b>
• <code>${mainPrefix}dme 10</code> - 处理最近10条
• <code>${mainPrefix}dme 999</code> - 处理所有能找到的消息`

const dme = async (msg: Api.Message) => {
  const client = await getGlobalClient()
  if (!client) {
    await msg.edit({ text: '❌ 客户端未初始化', parseMode: 'html' })
    return
  }

  // 参数解析
  const lines = msg.text?.trim()?.split(/\r?\n/g) || []
  const parts = lines?.[0]?.split(/\s+/) || []
  const args = parts.slice(1)
  const firstArg = (args[0] || '').toLowerCase()

  try {
    if (firstArg === 'help' || firstArg === 'h') {
      await msg.edit({ text: help_text, parseMode: 'html' })
      return
    }

    const me = await client.getMe()
    const myId = BigInt(me.id.toString())
    const chatId = msg.chatId?.toString() || msg.peerId?.toString() || ''
    const chatEntity = await getEntityWithHash(client, chatId)

    const replyMessage = await msg.getReplyMessage()

    // 删除指令本身
    try {
      await client.deleteMessages(chatEntity as any, [msg.id], {
        revoke: true
      })
    } catch {}

    console.log(`[DME] 开始执行任务...`)

    // ================== 场景1：回复消息处理 ==================
    if (replyMessage) {
      // 1.1 范围删除 (回复 + -r)
      if (args.includes('-r')) {
        console.log(`[DME] 回复+范围模式`)
        const result = await deleteRangeMessages(client, chatEntity, myId, replyMessage.id)
        console.log(`[DME] 范围处理完成: 删除 ${result.processedCount}, 编辑 ${result.editedCount}`)
      }
      // 1.2 单条删除 (回复无 -r)
      else {
        console.log(`[DME] 回复+单条模式`)
        if (replyMessage.senderId?.toString() === myId.toString()) {
          // 将单条消息作为数组传入通用处理函数
          await processBatchWithAntiRecall(client, chatEntity, [replyMessage])
          console.log(`[DME] 单条处理完成`)
        } else {
          console.log(`[DME] 跳过：非本人消息`)
        }
      }
    }
    // ================== 场景2：数量模式 (.dme 10) ==================
    else {
      let count = parseInt(firstArg)
      if (isNaN(count) || count <= 0) {
        // 如果没有回复且参数不对，默认可能是误触或需要帮助，但因为删除了命令，这里只打印日志
        console.log(`[DME] 参数无效`)
        return
      }

      console.log(`[DME] 数量模式: ${count}`)
      const result = await streamSearchAndProcess(client, chatEntity, myId, count)
      console.log(`[DME] 数量模式完成: 删除 ${result.processedCount}, 编辑 ${result.editedCount}`)
    }
  } catch (error: any) {
    console.error('[DME] 执行异常:', error)
  }
}

class DmePlugin extends Plugin {
  description: string = `智能防撤回删除插件\n\n${help_text}`
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    dme
  }
}

export default new DmePlugin()
