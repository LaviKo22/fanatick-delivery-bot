const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const { createClient } = require('@supabase/supabase-js')
const OpenAI = require('openai')
const express = require('express')
const pino = require('pino')
const QRCode = require('qrcode')

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

let sock = null, latestQR = null, connected = false
const activeGroups = {}, clientToGroup = {}

app.get('/qr', async (req, res) => {
    if (connected) return res.send('<h2 style="font-family:sans-serif;text-align:center;padding:40px">✅ WhatsApp is connected!</h2>')
    if (!latestQR) return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>⏳ Generating QR... please wait</h2><p>Refresh in 5 seconds</p><meta http-equiv="refresh" content="5"></body></html>')
    const qrImage = await QRCode.toDataURL(latestQR)
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>📱 Scan with WhatsApp on +447451267123</h2><p>Open WhatsApp → Linked Devices → Link a Device → Scan this code</p><img src="${qrImage}" style="width:300px;height:300px;border:2px solid #ccc;border-radius:12px"/><p><small>Auto-refreshes every 30s</small></p><meta http-equiv="refresh" content="30"></body></html>`)
})

app.get('/health', (req, res) => res.json({ status: 'ok', connected }))
app.get('/', (req, res) => res.json({ status: 'Fanatick Delivery Agent', connected, scan_qr: '/qr' }))

async function getDeliveryByGroup(groupId) {
    const id = activeGroups[groupId]
    if (!id) return null
    const { data } = await supabase.from('deliveries').select('*').eq('id', id).single()
    return data || null
}
async function updateDelivery(id, updates) { await supabase.from('deliveries').update(updates).eq('id', id) }
async function saveProof(deliveryId, proofUrl, proofType) { await supabase.from('delivery_proofs').insert({ delivery_id: deliveryId, proof_url: proofUrl, proof_type: proofType }) }

function formatJid(number) { return number.replace(/[^0-9]/g, '') + '@s.whatsapp.net' }
async function sendMsg(jid, text) { if (!sock || !connected) return; try { await sock.sendMessage(jid, { text }) } catch(e) { console.error('Send error:', e.message) } }

async function createGroup(delivery) {
    try {
        const group = await sock.groupCreate(`${delivery.game_name} · ${delivery.client_name}`, [formatJid(delivery.client_whatsapp), formatJid(TRADER_NUMBER)])
        activeGroups[group.id] = delivery.id
        clientToGroup[delivery.client_whatsapp] = group.id
        console.log('Group created:', group.id)
        return group.id
    } catch(e) { console.error('Group error:', e.message); return null }
}

async function analyzeImage(buffer, prompt) {
    try {
        const res = await openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}` } }] }], max_tokens: 150 })
        let raw = res.choices[0].message.content.trim()
        if (raw.includes('```')) raw = raw.split('```')[1].replace('json','').trim()
        return JSON.parse(raw)
    } catch(e) { return null }
}

function getIntent(m) {
    m = m.toLowerCase()
    if (/iphone|apple|ios/.test(m)) return 'iphone'
    if (/android|samsung|google|pixel|huawei/.test(m)) return 'android'
    if (/✅|yes|ok|done|got it|understood|ready|sure|yep|added/.test(m)) return 'confirmed'
    if (/help|can.t|stuck|how|not working|don.t see/.test(m)) return 'confused'
    if (/wrong|incorrect|mistake|different/.test(m)) return 'wrong'
    return 'other'
}

async function startDelivery(delivery) {
    const groupId = await createGroup(delivery)
    if (!groupId) return
    await sendMsg(groupId, `👋 Hi ${delivery.client_name}! I'm the Fanatick delivery assistant for *${delivery.game_name}*.\n\nAre you on *iPhone* or *Android*? 📱`)
    await updateDelivery(delivery.id, { status: 'phone_detected' })
}

async function handleMessage(msg) {
    const jid = msg.key.remoteJid, fromMe = msg.key.fromMe
    if (fromMe) return
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
    const sender = (msg.key.participant || jid).replace('@s.whatsapp.net', '')
    const isGroup = jid.endsWith('@g.us')
    let imgBuf = null
    if (msg.message?.imageMessage) { try { imgBuf = await sock.downloadMediaMessage(msg, 'buffer') } catch(e) {} }

    if (isGroup) {
        const d = await getDeliveryByGroup(jid)
        if (!d || sender === TRADER_NUMBER) return
        const s = d.status, intent = getIntent(text)
        if (s === 'phone_detected') {
            if (intent === 'iphone') { await updateDelivery(d.id, { status: 'briefed', phone_type: 'iphone' }); await sendMsg(jid, `Perfect 🍎 Before I send your link:\n\n⚠️ *Important:*\n• Do NOT share the link\n• Add to *Apple Wallet* immediately\n• Remove after the game\n\nReply ✅ when ready`) }
            else if (intent === 'android') { await updateDelivery(d.id, { status: 'briefed', phone_type: 'android' }); await sendMsg(jid, `Perfect 🤖 Before I send your link:\n\n⚠️ *Important:*\n• Do NOT share the link\n• Add to *Google Wallet* immediately\n• Remove after the game\n\nReply ✅ when ready`) }
            else await sendMsg(jid, `Are you on *iPhone* or *Android*? 📱`)
        } else if (s === 'briefed') {
            if (intent !== 'confirmed') { await sendMsg(jid, `Please reply ✅ when ready 👆`); return }
            const links = (d.links || '').split('\n').filter(l => l.trim())
            const wallet = d.phone_type === 'iphone' ? 'Apple Wallet' : 'Google Wallet'
            await sendMsg(jid, `Here are your ticket links:\n\n${links.map((l,i) => `🎫 *Ticket ${i+1}:*\n${l}`).join('\n\n')}\n\nFor each:\n1️⃣ Tap the link\n2️⃣ Add to *${wallet}*\n3️⃣ Send me a screenshot 📸`)
            await updateDelivery(d.id, { status: 'links_sent' })
        } else if (s === 'links_sent') {
            if (imgBuf) {
                const r = await analyzeImage(imgBuf, 'Does this show tickets in Apple or Google Wallet? JSON: {"confirmed":true/false,"notes":"brief"}')
                await saveProof(d.id, 'wallet_screenshot', 'wallet_screenshot')
                if (r?.confirmed) { await updateDelivery(d.id, { status: 'wallet_confirmed' }); await sendMsg(jid, `✅ *Confirmed!* Enjoy *${d.game_name}*! 🏟️⚽\n\nI'll remind you to remove the tickets after the game.`) }
                else await sendMsg(jid, `Can't confirm from that screenshot. Send another with all tickets visible 📸`)
            } else if (intent === 'confused') {
                await sendMsg(jid, d.phone_type === 'iphone' ? `Try:\n1. Open in *Safari*\n2. Scroll → *Add to Apple Wallet*\n3. Tap *Add*\n\nStill stuck? Send a screenshot 📱` : `Try:\n1. Open in *Chrome*\n2. Scroll → *Save to Google Wallet*\n3. Tap *Save*\n\nStill stuck? Send a screenshot 📱`)
            } else if (intent === 'wrong') {
                await sendMsg(jid, `Sorry! 🙏 The trader has been notified and will send the correct link shortly.`)
            } else await sendMsg(jid, `Once added, send me a screenshot 📸`)
        } else if (s === 'wallet_confirmed') {
            if (imgBuf) {
                const r = await analyzeImage(imgBuf, 'Are tickets removed from Apple/Google Wallet? JSON: {"removed":true/false,"notes":"brief"}')
                await saveProof(d.id, 'removal_proof', 'removal_proof')
                if (r?.removed) { await updateDelivery(d.id, { status: 'removed' }); await sendMsg(jid, `✅ Removal confirmed. Hope you enjoyed the game! 🙌`) }
                else await sendMsg(jid, `Can't confirm removal. Delete from wallet and send a screenshot 📱`)
            } else await sendMsg(jid, `👋 Game over — please *remove your tickets* now.\nSend me a screenshot confirming removal 📸`)
        }
        return
    }

    if (sender === TRADER_NUMBER) {
        const m = text.trim().toUpperCase()
        if (m === 'STATUS') {
            const { data } = await supabase.from('deliveries').select('client_name,game_name,status,order_number').not('status', 'in', '("removed")')
            if (!data?.length) { await sendMsg(jid, 'No active deliveries.'); return }
            await sendMsg(jid, '📊 *Active:*\n' + data.map(d => `• ${d.client_name} — ${d.game_name}\n  ${d.status} | #${d.order_number}`).join('\n'))
        } else if (m.startsWith('GAMEOVER')) {
            const phone = text.replace(/GAMEOVER/i,'').trim()
            const groupId = clientToGroup[phone]
            if (groupId) await sendMsg(groupId, `👋 Game over — please *remove your tickets* now.\nSend me a screenshot 📸`)
            else await sendMsg(jid, `No active group for ${phone}`)
        } else {
            await sendMsg(jid, `Commands:\nSTATUS\nGAMEOVER +44xxx`)
        }
    }
}

app.post('/start-delivery', async (req, res) => {
    const { delivery_id } = req.body
    if (!delivery_id) return res.status(400).json({ error: 'delivery_id required' })
    if (!connected) return res.status(503).json({ error: 'WhatsApp not connected. Scan QR at /qr' })
    const { data: delivery } = await supabase.from('deliveries').select('*').eq('id', delivery_id).single()
    if (!delivery) return res.status(404).json({ error: 'Not found' })
    await startDelivery(delivery)
    res.json({ success: true, message: `Started for ${delivery.client_name}` })
})

async function connectWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info')
    sock = makeWASocket({ auth: state, logger, printQRInTerminal: false, browser: ['Fanatick', 'Chrome', '1.0'] })
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) { latestQR = qr; connected = false; console.log(`📱 QR ready — visit /qr to scan`) }
        if (connection === 'close') {
            connected = false
            const code = lastDisconnect?.error?.output?.statusCode
            console.log('Disconnected. Code:', code)
            if (code !== DisconnectReason.loggedOut) setTimeout(connectWhatsApp, 3000)
        } else if (connection === 'open') {
            connected = true; latestQR = null
            console.log('✅ WhatsApp connected!')
        }
    })
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        for (const msg of messages) { if (!msg.message) continue; try { await handleMessage(msg) } catch(e) { console.error(e.message) } }
    })
}

app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`))
connectWhatsApp()
