const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const { createClient } = require('@supabase/supabase-js')
const OpenAI = require('openai')
const express = require('express')
const pino = require('pino')

const TRADER_NUMBER  = process.env.TRADER_NUMBER  || '447451295914'
const SUPABASE_URL   = process.env.SUPABASE_URL   || 'https://igrlhrtjcmippqilqgyx.supabase.co'
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const PORT           = process.env.PORT || 3000

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY })
const app      = express()
app.use(express.json())
const logger = pino({ level: 'silent' })

const activeGroups  = {}
const clientToGroup = {}
let sock = null
let latestQR = null

async function getDeliveryByGroup(groupId) {
    const deliveryId = activeGroups[groupId]
    if (!deliveryId) return null
    const { data } = await supabase.from('deliveries').select('*').eq('id', deliveryId).single()
    return data || null
}

async function updateDelivery(id, updates) {
    await supabase.from('deliveries').update(updates).eq('id', id)
}

async function saveProof(deliveryId, proofType) {
    await supabase.from('delivery_proofs').insert({ delivery_id: deliveryId, proof_url: proofType, proof_type: proofType })
}

function formatJid(number) {
    return number.replace(/[^0-9]/g, '') + '@s.whatsapp.net'
}

async function sendMsg(jid, text) {
    if (!sock) return
    try { await sock.sendMessage(jid, { text }) } catch(e) { console.error('Send error:', e.message) }
}

async function createGroup(delivery) {
    if (!sock) return null
    try {
        const clientJid = formatJid(delivery.client_whatsapp)
        const traderJid = formatJid(TRADER_NUMBER)
        const group = await sock.groupCreate(`${delivery.game_name} - ${delivery.client_name}`, [clientJid, traderJid])
        activeGroups[group.id] = delivery.id
        clientToGroup[delivery.client_whatsapp] = group.id
        console.log('Group created:', group.id)
        return group.id
    } catch(e) {
        console.error('Group error:', e.message)
        return null
    }
}

async function analyzeImage(buffer, prompt) {
    try {
        const b64 = buffer.toString('base64')
        const res = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
            ]}],
            max_tokens: 150
        })
        let raw = res.choices[0].message.content.trim()
        if (raw.includes('```')) raw = raw.split('```')[1].replace('json','').trim()
        return JSON.parse(raw)
    } catch(e) { return null }
}

function getIntent(msg) {
    const m = msg.toLowerCase()
    if (/iphone|apple|ios/.test(m)) return 'iphone'
    if (/android|samsung|google|pixel|huawei/.test(m)) return 'android'
    if (/yes|ok|done|got it|understood|ready|sure|yep|added/.test(m) || msg.includes('✅')) return 'confirmed'
    if (/help|can't|cant|stuck|how|not working/.test(m)) return 'confused'
    if (/wrong|incorrect|mistake|different/.test(m)) return 'wrong'
    return 'other'
}

async function startDelivery(delivery) {
    const groupId = await createGroup(delivery)
    if (!groupId) return
    await sendMsg(groupId, `👋 Hi ${delivery.client_name}! I'm the Fanatick delivery assistant for *${delivery.game_name}*.\n\nAre you on *iPhone* or *Android*? 📱`)
    await updateDelivery(delivery.id, { status: 'phone_detected' })
}

async function handlePhoneDetect(gid, d, msg) {
    const intent = getIntent(msg)
    if (intent === 'iphone') {
        await updateDelivery(d.id, { status: 'briefed', phone_type: 'iphone' })
        await sendMsg(gid, `Perfect 🍎 Before I send your link:\n\n⚠️ *Important:*\n• Do NOT share the link\n• Add to *Apple Wallet* immediately\n• Keep until after the game\n• Remove after full time\n\nReply ✅ when ready`)
    } else if (intent === 'android') {
        await updateDelivery(d.id, { status: 'briefed', phone_type: 'android' })
        await sendMsg(gid, `Perfect 🤖 Before I send your link:\n\n⚠️ *Important:*\n• Do NOT share the link\n• Add to *Google Wallet* immediately\n• Keep until after the game\n• Remove after full time\n\nReply ✅ when ready`)
    } else {
        await sendMsg(gid, `Are you on *iPhone* or *Android*? 📱`)
    }
}

async function handleBriefed(gid, d, msg) {
    if (getIntent(msg) !== 'confirmed') { await sendMsg(gid, `Please reply ✅ when ready 👆`); return }
    const links = (d.links || '').split('\n').filter(l => l.trim())
    const wallet = d.phone_type === 'iphone' ? 'Apple Wallet' : 'Google Wallet'
    const linksText = links.map((l, i) => `🎫 *Ticket ${i+1}:*\n${l}`).join('\n\n')
    await sendMsg(gid, `Here are your links:\n\n${linksText}\n\n1️⃣ Tap each link\n2️⃣ Add to *${wallet}*\n3️⃣ Screenshot your wallet 📸`)
    await updateDelivery(d.id, { status: 'links_sent' })
}

async function handleLinksSent(gid, d, msg, imgBuf) {
    if (imgBuf) {
        const result = await analyzeImage(imgBuf, 'Does this show tickets in Apple or Google Wallet? JSON only: {"confirmed":true,"notes":"brief"}')
        await saveProof(d.id, 'wallet_screenshot')
        if (result?.confirmed) {
            await updateDelivery(d.id, { status: 'wallet_confirmed' })
            await sendMsg(gid, `✅ *Confirmed!* Enjoy *${d.game_name}*! 🏟️⚽\n\nI'll remind you to remove after full time.`)
        } else {
            await sendMsg(gid, `Can't confirm. Make sure tickets are visible and send another screenshot 📸`)
        }
    } else if (getIntent(msg) === 'confused') {
        await sendMsg(gid, d.phone_type === 'iphone'
            ? `Try:\n1. Open in *Safari*\n2. Scroll → *Add to Apple Wallet*\n3. Tap *Add*\n\nStuck? Send screenshot 📱`
            : `Try:\n1. Open in *Chrome*\n2. Scroll → *Save to Google Wallet*\n3. Tap *Save*\n\nStuck? Send screenshot 📱`)
    } else {
        await sendMsg(gid, `Once added, send me a screenshot 📸`)
    }
}

async function handleWalletConfirmed(gid, d, msg, imgBuf) {
    if (imgBuf) {
        const result = await analyzeImage(imgBuf, 'Has this ticket been removed from Apple/Google Wallet? JSON only: {"removed":true,"notes":"brief"}')
        await saveProof(d.id, 'removal_proof')
        if (result?.removed) {
            await updateDelivery(d.id, { status: 'removed' })
            await sendMsg(gid, `✅ Tickets removed. Thanks, hope you enjoyed the game! 🙌`)
        } else {
            await sendMsg(gid, `Can't confirm. Delete from wallet and send a screenshot 📱`)
        }
    } else {
        await sendMsg(gid, `👋 Game over — please *remove your tickets* now and send a screenshot 📸`)
    }
}

async function handleMessage(msg) {
    if (msg.key.fromMe) return
    const jid     = msg.key.remoteJid
    const isGroup = jid.endsWith('@g.us')
    const sender  = msg.key.participant || jid
    const text    = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
    let imgBuf = null
    if (msg.message?.imageMessage) {
        try { imgBuf = await sock.downloadMediaMessage(msg, 'buffer') } catch(e) {}
    }
    if (!isGroup) return
    const d = await getDeliveryByGroup(jid)
    if (!d) return
    const senderNum = sender.replace('@s.whatsapp.net', '')
    if (senderNum === TRADER_NUMBER) return
    const s = d.status
    if (s === 'phone_detected')      await handlePhoneDetect(jid, d, text)
    else if (s === 'briefed')        await handleBriefed(jid, d, text)
    else if (s === 'links_sent')     await handleLinksSent(jid, d, text, imgBuf)
    else if (s === 'wallet_confirmed') await handleWalletConfirmed(jid, d, text, imgBuf)
}

async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info')
    sock = makeWASocket({ auth: state, logger, printQRInTerminal: false, browser: ['Fanatick', 'Chrome', '1.0'] })
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            latestQR = qr
            const url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`
            console.log('QR URL:', url)
        }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode
            console.log('Disconnected. Code:', code)
            if (code !== DisconnectReason.loggedOut) setTimeout(connect, 3000)
        } else if (connection === 'open') {
            latestQR = null
            console.log('✅ WhatsApp connected!')
        }
    })
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        for (const msg of messages) { if (msg.message) await handleMessage(msg) }
    })
}

app.get('/qr', (req, res) => {
    if (!latestQR) return res.send('<h2>No QR yet — already connected or not ready. Refresh in 5s.</h2>')
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(latestQR)}`
    res.send(`<html><body style="text-align:center;font-family:sans-serif;padding:40px"><h2>Scan with WhatsApp on +447451267123</h2><img src="${url}" style="width:300px"/><p><a href="/qr">Refresh if expired</a></p></body></html>`)
})

app.post('/start-delivery', async (req, res) => {
    const { delivery_id } = req.body
    if (!delivery_id) return res.status(400).json({ error: 'delivery_id required' })
    const { data: d } = await supabase.from('deliveries').select('*').eq('id', delivery_id).single()
    if (!d) return res.status(404).json({ error: 'Not found' })
    await startDelivery(d)
    res.json({ success: true })
})

app.get('/status', (req, res) => res.json({ connected: !!sock && !latestQR, hasQR: !!latestQR, activeDeliveries: Object.keys(activeGroups).length }))
app.get('/health', (req, res) => res.json({ status: 'ok' }))
app.get('/', (req, res) => res.json({ status: 'Fanatick Delivery Agent running' }))

app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`))
connect()
