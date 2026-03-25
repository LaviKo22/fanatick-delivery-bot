const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, makeInMemoryStore } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const { createClient } = require('@supabase/supabase-js')
const OpenAI = require('openai')
const express = require('express')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const pino = require('pino')

// ============================================================
//  CONFIG
// ============================================================

const TRADER_NUMBER   = process.env.TRADER_NUMBER   || '447451295914'
const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://igrlhrtjcmippqilqgyx.supabase.co'
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY  || ''
const PORT            = process.env.PORT            || 3000

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY })
const app      = express()
app.use(express.json())

const logger = pino({ level: 'silent' })

// Store active groups: groupId -> deliveryId
const activeGroups = {}
// Store delivery number mapping: clientNumber -> groupId
const clientToGroup = {}

let sock = null

// ============================================================
//  SUPABASE HELPERS
// ============================================================

async function getDeliveryByPhone(phone) {
    const clean = phone.replace(/[^0-9]/g, '')
    const { data } = await supabase
        .from('deliveries')
        .select('*')
        .eq('client_whatsapp', '+' + clean)
        .not('status', 'in', '("removed")')
        .order('created_at', { ascending: false })
        .limit(1)
    return data?.[0] || null
}

async function getDeliveryByGroup(groupId) {
    const deliveryId = activeGroups[groupId]
    if (!deliveryId) return null
    const { data } = await supabase
        .from('deliveries')
        .select('*')
        .eq('id', deliveryId)
        .single()
    return data || null
}

async function updateDelivery(id, updates) {
    await supabase.from('deliveries').update(updates).eq('id', id)
    console.log(`Updated delivery ${id}:`, updates)
}

async function saveProof(deliveryId, proofUrl, proofType = 'screenshot') {
    await supabase.from('delivery_proofs').insert({
        delivery_id: deliveryId,
        proof_url: proofUrl,
        proof_type: proofType
    })
}

// ============================================================
//  WHATSAPP HELPERS
// ============================================================

function formatNumber(number) {
    const clean = number.replace(/[^0-9]/g, '')
    return clean + '@s.whatsapp.net'
}

async function sendMessage(jid, text) {
    if (!sock) return
    await sock.sendMessage(jid, { text })
}

async function createDeliveryGroup(delivery) {
    if (!sock) return null
    try {
        const clientJid  = formatNumber(delivery.client_whatsapp)
        const traderJid  = formatNumber(TRADER_NUMBER)
        const groupName  = `${delivery.game_name} - ${delivery.client_name}`

        const group = await sock.groupCreate(groupName, [clientJid, traderJid])
        const groupId = group.id

        // Store mapping
        activeGroups[groupId] = delivery.id
        clientToGroup[delivery.client_whatsapp] = groupId

        console.log(`Created group ${groupId} for delivery ${delivery.id}`)
        return groupId
    } catch (err) {
        console.error('Group creation error:', err)
        return null
    }
}

// ============================================================
//  GPT HELPERS
// ============================================================

async function analyzeImage(imageBuffer, prompt) {
    try {
        const b64 = imageBuffer.toString('base64')
        const res = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
                ]
            }],
            max_tokens: 200
        })
        let raw = res.choices[0].message.content.trim()
        if (raw.includes('```')) raw = raw.split('```')[1].replace('json', '').trim()
        return JSON.parse(raw)
    } catch (err) {
        console.error('Image analysis error:', err)
        return null
    }
}

async function checkWallet(imageBuffer) {
    return await analyzeImage(imageBuffer,
        'Does this screenshot show tickets in Apple Wallet or Google Wallet? Reply JSON only: {"confirmed": true/false, "notes": "brief"}')
}

async function checkRemoval(imageBuffer) {
    return await analyzeImage(imageBuffer,
        'Does this show tickets have been removed/deleted from Apple or Google Wallet? Reply JSON only: {"removed": true/false, "notes": "brief"}')
}

function getIntent(message) {
    const m = message.toLowerCase().trim()
    if (/iphone|apple|ios/.test(m))                                    return 'iphone'
    if (/android|samsung|google|pixel|huawei/.test(m))                 return 'android'
    if (/✅|yes|ok|done|got it|understood|ready|sure|yep|added/.test(m)) return 'confirmed'
    if (/help|can't|cant|stuck|how|not working|don't see/.test(m))     return 'confused'
    if (/wrong|incorrect|mistake|different seat|wrong link/.test(m))   return 'wrong'
    return 'other'
}

// ============================================================
//  DELIVERY FLOW
// ============================================================

async function startDelivery(delivery) {
    // Create WhatsApp group
    const groupId = await createDeliveryGroup(delivery)
    if (!groupId) {
        console.error('Failed to create group for delivery', delivery.id)
        return
    }

    // Welcome message in group
    await sendMessage(groupId,
        `👋 Hi ${delivery.client_name}! I'm the Fanatick delivery assistant for *${delivery.game_name}*.\n\n` +
        `Are you on *iPhone* or *Android*? 📱`
    )

    await updateDelivery(delivery.id, { status: 'phone_detected' })
}

async function handlePhoneDetect(groupId, delivery, message) {
    const intent = getIntent(message)
    if (intent === 'iphone') {
        await updateDelivery(delivery.id, { status: 'briefed', phone_type: 'iphone' })
        await sendMessage(groupId,
            `Perfect 🍎 Before I send your ticket link, please read this:\n\n` +
            `⚠️ *Important:*\n` +
            `• Do NOT share the link\n` +
            `• Add to *Apple Wallet* immediately\n` +
            `• Keep until after the game\n` +
            `• Remove after full time\n\n` +
            `Reply ✅ when ready`
        )
    } else if (intent === 'android') {
        await updateDelivery(delivery.id, { status: 'briefed', phone_type: 'android' })
        await sendMessage(groupId,
            `Perfect 🤖 Before I send your ticket link, please read this:\n\n` +
            `⚠️ *Important:*\n` +
            `• Do NOT share the link\n` +
            `• Add to *Google Wallet* immediately\n` +
            `• Keep until after the game\n` +
            `• Remove after full time\n\n` +
            `Reply ✅ when ready`
        )
    } else {
        await sendMessage(groupId, `Are you on *iPhone* or *Android*? 📱`)
    }
}

async function handleBriefed(groupId, delivery, message) {
    if (getIntent(message) !== 'confirmed') {
        await sendMessage(groupId, `Please reply ✅ when you've read the instructions 👆`)
        return
    }

    const links = delivery.links
        ? delivery.links.split('\n').filter(l => l.trim())
        : []

    const wallet = delivery.phone_type === 'iphone' ? 'Apple Wallet' : 'Google Wallet'
    const linksText = links.map((l, i) => `🎫 *Ticket ${i+1}:*\n${l}`).join('\n\n')

    await sendMessage(groupId,
        `Here are your ticket links:\n\n${linksText}\n\n` +
        `For each:\n1️⃣ Tap the link\n2️⃣ Add to *${wallet}*\n` +
        `3️⃣ Send me a screenshot of your wallet 📸`
    )
    await updateDelivery(delivery.id, { status: 'links_sent' })
}

async function handleLinksSent(groupId, delivery, message, imageBuffer) {
    const intent = getIntent(message)

    if (imageBuffer) {
        const result = await checkWallet(imageBuffer)
        await saveProof(delivery.id, 'wallet_screenshot', 'wallet_screenshot')

        if (result?.confirmed) {
            await updateDelivery(delivery.id, { status: 'wallet_confirmed' })
            await sendMessage(groupId,
                `✅ *Confirmed!* Tickets are in your wallet.\n\n` +
                `Enjoy *${delivery.game_name}*! 🏟️⚽\n\n` +
                `I'll message you after full time to remind you to remove the tickets.`
            )
        } else {
            await sendMessage(groupId,
                `Hmm, I can't confirm the tickets in that screenshot.\n` +
                `Make sure all tickets are visible and send another 📸`
            )
        }
    } else if (intent === 'confused') {
        const isIphone = delivery.phone_type === 'iphone'
        await sendMessage(groupId, isIphone
            ? `Try this:\n1. Open link in *Safari*\n2. Scroll down → *Add to Apple Wallet*\n3. Tap *Add*\n\nStill stuck? Send a screenshot 📱`
            : `Try this:\n1. Open link in *Chrome*\n2. Scroll down → *Save to Google Wallet*\n3. Tap *Save*\n\nStill stuck? Send a screenshot 📱`
        )
    } else if (intent === 'wrong') {
        await sendMessage(groupId,
            `Sorry about that! 🙏 The trader has been notified and will send the correct link shortly.`
        )
        // Notify trader in group
        await sendMessage(groupId,
            `⚠️ *[Trader]* Wrong link reported — please send the correct links above.`
        )
    } else {
        await sendMessage(groupId, `Once added, send me a screenshot of your wallet 📸`)
    }
}

async function handleWalletConfirmed(groupId, delivery, message, imageBuffer) {
    if (imageBuffer) {
        const result = await checkRemoval(imageBuffer)
        await saveProof(delivery.id, 'removal_proof', 'removal_proof')

        if (result?.removed) {
            await updateDelivery(delivery.id, { status: 'removed' })
            await sendMessage(groupId,
                `✅ Tickets removed confirmed. Thanks, hope you enjoyed the game! 🙌`
            )
        } else {
            await sendMessage(groupId,
                `Can't confirm removal. Please delete from wallet and send a screenshot 📱`
            )
        }
    } else {
        await sendMessage(groupId,
            `👋 Game over — please *remove your tickets from your wallet* now.\n` +
            `Send me a screenshot confirming removal 📸`
        )
    }
}

// ============================================================
//  MESSAGE HANDLER
// ============================================================

async function handleMessage(msg) {
    const jid      = msg.key.remoteJid
    const fromMe   = msg.key.fromMe
    const isGroup  = jid.endsWith('@g.us')
    const sender   = msg.key.participant || jid

    if (fromMe) return

    const text = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || ''

    // Download image if present
    let imageBuffer = null
    if (msg.message?.imageMessage) {
        try {
            const stream = await sock.downloadMediaMessage(msg, 'buffer')
            imageBuffer = stream
        } catch (err) {
            console.error('Image download error:', err)
        }
    }

    // Handle group messages
    if (isGroup) {
        const delivery = await getDeliveryByGroup(jid)
        if (!delivery) return

        const senderClean = sender.replace('@s.whatsapp.net', '')
        const isTrader = senderClean === TRADER_NUMBER

        // If trader sends a message in group — just let it through, don't process
        if (isTrader) return

        const status = delivery.status
        if (status === 'phone_detected') await handlePhoneDetect(jid, delivery, text)
        else if (status === 'briefed')    await handleBriefed(jid, delivery, text)
        else if (status === 'links_sent') await handleLinksSent(jid, delivery, text, imageBuffer)
        else if (status === 'wallet_confirmed') await handleWalletConfirmed(jid, delivery, text, imageBuffer)
        return
    }

    // Handle direct messages from trader
    const senderClean = sender.replace('@s.whatsapp.net', '')
    if (senderClean === TRADER_NUMBER) {
        await handleTraderCommand(text, jid)
    }
}

async function handleTraderCommand(msg, traderJid) {
    const m = msg.trim()

    if (m.toUpperCase() === 'HELP') {
        await sendMessage(traderJid,
            `🤖 *Commands:*\n` +
            `STATUS — active deliveries\n` +
            `GAMEOVER +44xxx — trigger removal chase\n` +
            `CANCEL +44xxx — cancel delivery`
        )
        return
    }

    if (m.toUpperCase() === 'STATUS') {
        const { data } = await supabase
            .from('deliveries')
            .select('client_name,game_name,status,order_number')
            .not('status', 'in', '("removed")')
        if (!data?.length) {
            await sendMessage(traderJid, 'No active deliveries.')
            return
        }
        const lines = ['📊 *Active deliveries:*\n']
        for (const d of data) {
            lines.push(`• ${d.client_name} — ${d.game_name}\n  ${d.status} | #${d.order_number}`)
        }
        await sendMessage(traderJid, lines.join('\n'))
        return
    }

    if (m.toUpperCase().startsWith('GAMEOVER')) {
        const phone = m.replace(/GAMEOVER/i, '').trim()
        const groupId = clientToGroup[phone]
        if (groupId) {
            await sendMessage(groupId,
                `👋 The game is over — please *remove your tickets from your wallet* now.\n` +
                `Send me a screenshot confirming removal 📸`
            )
            await sendMessage(traderJid, `✅ Removal chase sent`)
        } else {
            await sendMessage(traderJid, `No active group for ${phone}`)
        }
        return
    }
}

// ============================================================
//  BAILEYS CONNECTION
// ============================================================

async function connectWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info')

    sock = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: true,
        browser: ['Fanatick', 'Chrome', '1.0']
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`
            console.log('📱 SCAN THIS QR CODE:')
            console.log(qrUrl)
            console.log('Open the URL above in your browser and scan with WhatsApp on +447451267123')
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('Connection closed. Reconnecting:', shouldReconnect)
            if (shouldReconnect) connectWhatsApp()
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connected!')
        }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        for (const msg of messages) {
            if (!msg.message) continue
            await handleMessage(msg)
        }
    })
}

// ============================================================
//  EXPRESS API — called by dashboard to start deliveries
// ============================================================

app.post('/start-delivery', async (req, res) => {
    const { delivery_id } = req.body
    if (!delivery_id) return res.status(400).json({ error: 'delivery_id required' })

    const { data: delivery } = await supabase
        .from('deliveries')
        .select('*')
        .eq('id', delivery_id)
        .single()

    if (!delivery) return res.status(404).json({ error: 'Delivery not found' })

    await startDelivery(delivery)
    res.json({ success: true, message: `Delivery started for ${delivery.client_name}` })
})

app.get('/health', (req, res) => res.json({ status: 'ok', connected: !!sock }))
app.get('/', (req, res) => res.json({ status: 'Fanatick Delivery Agent running' }))

// ============================================================
//  START
// ============================================================

app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`))
connectWhatsApp()
