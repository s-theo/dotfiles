import { Plugin } from '@utils/pluginBase'
import { getPrefixes } from '@utils/pluginManager'
import { Api } from 'teleproto'
import * as fs from 'fs/promises'
import axios from 'axios'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { createDirectoryInAssets } from '@utils/pathHelpers'

const prefixes = getPrefixes()
const mainPrefix = prefixes[0]

const execPromise = promisify(exec)
const EDGE_TTS = '/root/.local/bin/edge-tts' // ✅ 强制绝对路径

const DATA_FILE_NAME = 'tts_data.json'

interface UserConfig {
  defaultRole: string
  defaultRoleId: string
}

interface AllUserData {
  users: Record<string, UserConfig>
  roles: Record<string, string>
  covers?: Record<string, string>
}

const dataFilePath = path.join(createDirectoryInAssets('tts-plugin'), DATA_FILE_NAME)
const cacheDir = createDirectoryInAssets('tts-plugin/cache')

function getInitialRoles(): Record<string, string> {
  return {
    晓晓: 'zh-CN-XiaoxiaoNeural',
    云希: 'zh-CN-YunxiNeural',
    晓伊: 'zh-CN-XiaoyiNeural',
    云扬: 'zh-CN-YunyangNeural',
    台湾女: 'zh-TW-HsiaoChenNeural',
    英文男: 'en-US-GuyNeural',
    英文女: 'en-US-JennyNeural'
  }
}

async function loadUserData(): Promise<AllUserData> {
  try {
    const data = await fs.readFile(dataFilePath, 'utf8')
    const parsed: AllUserData = JSON.parse(data)

    if (!parsed.roles) parsed.roles = {}
    if (!parsed.covers) parsed.covers = {}

    const initial = getInitialRoles()
    let changed = false
    for (const [name, id] of Object.entries(initial)) {
      if (!(name in parsed.roles)) {
        parsed.roles[name] = id
        changed = true
      }
    }
    if (changed) await saveUserData(parsed)
    return parsed
  } catch {
    const initial: AllUserData = {
      users: {},
      roles: getInitialRoles(),
      covers: {}
    }
    await saveUserData(initial)
    return initial
  }
}

async function saveUserData(userData: AllUserData) {
  await fs.writeFile(dataFilePath, JSON.stringify(userData, null, 2), 'utf8')
}

function cleanTextForTTS(text: string): string {
  return text.replace(/["']/g, '').trim()
}

async function generateSpeechSimple(text: string, voice: string): Promise<{ oggFile: string; mp3File: string } | null> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const mp3File = path.join(cacheDir, `tts-${unique}.mp3`)
  const oggFile = path.join(cacheDir, `tts-${unique}.ogg`)

  try {
    console.log('TTS text:', text)
    console.log('Voice:', voice)

    const safeText = text.replace(/"/g, '\\"')

    await execPromise(`${EDGE_TTS} --voice ${voice} --text "${safeText}" --write-media "${mp3File}"`)

    await execPromise(`ffmpeg -y -i "${mp3File}" -c:a libopus -b:a 64k "${oggFile}"`)

    console.log('生成成功:', oggFile)

    return { oggFile, mp3File }
  } catch (e) {
    console.error('TTS error:', e)
    return null
  }
}

async function generateMusic(text: string, voice: string, meta: { title: string; artist: string; album: string; cover?: string }): Promise<string | null> {
  const unique = Date.now()
  const rawFile = path.join(cacheDir, `tts-${unique}.mp3`)
  const finalFile = path.join(cacheDir, `tts-${unique}-meta.mp3`)

  try {
    await execPromise(`${EDGE_TTS} --voice ${voice} --text "${text}" --write-media "${rawFile}"`)

    const cmd: string[] = [`ffmpeg -y -i "${rawFile}"`]

    if (meta.cover) {
      const coverPath = path.join(cacheDir, `${meta.album}.jpg`)
      try {
        await fs.access(coverPath)
      } catch {
        const res = await axios.get(meta.cover, {
          responseType: 'arraybuffer'
        })
        await fs.writeFile(coverPath, res.data)
      }

      cmd.push(`-i "${coverPath}"`, `-map 0:a -map 1:v`, `-c:a libmp3lame -q:a 2`, `-c:v mjpeg`, `-id3v2_version 3`, `-disposition:v attached_pic`)
    }

    cmd.push(`-metadata title="${meta.title}"`, `-metadata artist="${meta.artist}"`, `-metadata album="${meta.album}"`, `"${finalFile}"`)

    await execPromise(cmd.join(' '))
    return finalFile
  } catch (e) {
    console.error('Music error:', e)
    return null
  }
}

async function tts(msg: Api.Message) {
  const userId = msg.senderId?.toString()
  if (!userId) return

  const userData = await loadUserData()
  let cfg = userData.users[userId]

  if (!cfg) {
    cfg = {
      defaultRole: '晓晓',
      defaultRoleId: userData.roles['晓晓']
    }
    userData.users[userId] = cfg
    await saveUserData(userData)
  }

  const parts = msg.text?.split(/\s+/).slice(1) || []

  // ===== 音乐模式 =====
  if (parts.length >= 3) {
    const title = parts[0]
    const artist = parts[1]
    const text = parts.slice(2).join(' ')

    const file = await generateMusic(cleanTextForTTS(text), cfg.defaultRoleId, {
      title,
      artist,
      album: 'TTS'
    })

    if (file) {
      await msg.client?.sendFile(msg.peerId, { file })
      try {
        await msg.delete({ revoke: true })
      } catch {}
    }
    return
  }

  // ===== 普通语音 =====
  const text = parts.join(' ')
  if (!text) {
    await msg.edit({ text: '❌ 请输入文本' })
    return
  }

  const r = await generateSpeechSimple(cleanTextForTTS(text), cfg.defaultRoleId)

  if (!r) {
    await msg.edit({ text: '❌ 生成失败' })
    return
  }

  // 👉 先发语音
  await msg.client?.sendFile(msg.peerId, {
    file: r.oggFile,
    attributes: [
      new (Api as any).DocumentAttributeAudio({
        voice: true
      })
    ]
  })

  // 👉 再删原消息（关键修复点）
  try {
    await msg.delete({ revoke: true })
  } catch (e) {
    console.error('delete failed:', e)
  }
}

async function ttsSet(msg: Api.Message) {
  const userId = msg.senderId?.toString()
  if (!userId) return

  const args = msg.text?.split(/\s+/).slice(1) || []
  const userData = await loadUserData()

  const roleName = args[0]
  if (userData.roles[roleName]) {
    userData.users[userId] = {
      defaultRole: roleName,
      defaultRoleId: userData.roles[roleName]
    }
    await saveUserData(userData)
    await msg.edit({ text: `✅ 切换为 ${roleName}` })
  }
}

class TTSPlugin extends Plugin {
  description = `
🚀 免费文字转语音（edge-tts）

📝 基本用法：
• .t 文本            → 生成语音
• .ts 角色名         → 切换语音角色

🎭 支持角色列表：
• 晓晓    zh-CN-XiaoxiaoNeural
• 云希    zh-CN-YunxiNeural
• 晓伊    zh-CN-XiaoyiNeural
• 云扬    zh-CN-YunyangNeural
• 台湾女  zh-TW-HsiaoChenNeural
• 英文男  en-US-GuyNeural
• 英文女  en-US-JennyNeural

⚡ 特性：
• 自动删除命令消息
• 免费无限使用（edge-tts）
• 支持音乐模式（.t 歌曲名 歌手 文本）
`

  cmdHandlers = {
    t: tts,
    ts: ttsSet
  }
}

export default new TTSPlugin()
