import 'dotenv/config'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'

const SN_URL = 'https://stacker.news'
const NOSTR_SEC = process.env.NOSTR_SEC
const SUB = 'Design'
const TITLE_PREFIX = 'What creative ideas have you been rambling on?'

const IMAGES = [
  "![Don't Wait for Inspiration. It comes while Working - Henri Matisse](https://m.stacker.news/105111)",
  '![True happiness is not attained through self-gratification, but through fidelity to a worthy purpose. - Helen Keller](https://m.stacker.news/119126)',
  '![MaindBlowing](https://m.stacker.news/97749)',
  '![The Creative Adult is the Child Who Survived - Ursula Le Guin](https://m.stacker.news/116903)',
  `![I don't care that they stole my idea . . I care that they don't have any of their own - Nikola Tesla](https://m.stacker.news/114266)`,
  '![The best way to predict your future is to create it. - Abraham Lincoln](https://m.stacker.news/112173)',
  '![Creativity is Intelligence Having Fun - Albert Einstein](https://m.stacker.news/99470)',
  '![Tune on Awe, Find the Creative Vocabulary to Express your Work - Rick Rubin](https://m.stacker.news/103510)',
  '![Belief in Your Creative capacity lies at the Heart of Innovation - Tom & David Kelley](https://m.stacker.news/106701)',
  '![The essence of style is a simple way of saying something complex. - Giorgio Armani](https://m.stacker.news/108291)',
  '![Everything you can imagine is real. - Pablo Picasso](https://m.stacker.news/110233)'
]

const DRY_RUN = process.argv.includes('--dry-run')
const FIRST_POST_ID = 1291247

if (!NOSTR_SEC) {
  console.error('NOSTR_SEC environment variable is required')
  process.exit(1)
}

// --- Helpers ---

function pickRandomImage () {
  return IMAGES[Math.floor(Math.random() * IMAGES.length)]
}

function formatNames (names) {
  if (names.length === 0) return ''
  const tagged = names.map(n => `@${n}`)
  if (tagged.length === 1) return tagged[0]
  if (tagged.length === 2) return `${tagged[0]} and ${tagged[1]}`
  return `${tagged.slice(0, -1).join(', ')}, and ${tagged[tagged.length - 1]}`
}

// --- Post content ---

function buildText (prevItemId, userNames, imageMd) {
  const parts = []

  if (imageMd) {
    parts.push(imageMd, '')
  }

  parts.push(
    'This post is part of a series. It is meant to be a place for stackers to discuss creative projects they have been working on, or ideas they are aiming to build.  Regardless of your project being personal, professional, physical, digital, or even simply an idea to brainstorm together.',
    '',
    'If you have any creative projects or ideas that you have been working on or want to eventually work on... This is a place for discussing those, gather initial feedback and feel more energetic on bringing it to the next level.'
  )

  if (userNames.length > 0) {
    const previousLink = `${SN_URL}/items/${prevItemId}/r/Design_r`
    parts.push(
      '',
      `Thanks ${formatNames(userNames)} for joining and sharing your ideas in the [previous edition](${previousLink}). How are you all doing with your projects? Any update?`
    )
  }

  parts.push(
    '',
    '_**₿e Creative, have Fun!**_'
  )

  return parts.join('\n')
}

// --- Cookie jar ---

const cookies = {}

function parseSetCookie (setCookie) {
  if (!setCookie) return
  const parts = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const part of parts) {
    const [pairs] = part.split(';')
    const eqIdx = pairs.indexOf('=')
    if (eqIdx === -1) continue
    const name = pairs.slice(0, eqIdx).trim()
    const value = pairs.slice(eqIdx + 1).trim()
    cookies[name] = value
  }
}

function cookieHeader () {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
}

async function snFetch (path, opts = {}) {
  const url = `${SN_URL}${path}`
  const headers = {
    ...opts.headers,
  }
  if (Object.keys(cookies).length > 0) {
    headers.cookie = cookieHeader()
  }
  const res = await fetch(url, { ...opts, headers, redirect: 'manual' })
  parseSetCookie(res.headers.getSetCookie?.() || res.headers.get('set-cookie'))
  return res
}

async function gql (query, variables, operationName) {
  const body = JSON.stringify({ operationName, query, variables })
  const res = await snFetch('/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  })
  const json = await res.json()
  if (json.errors) {
    console.error(`GraphQL error in ${operationName}:`, JSON.stringify(json.errors, null, 2))
  }
  return json
}

// --- Step 1: Create auth challenge ---

async function createAuthChallenge () {
  const body = await gql(
    'mutation createAuth { createAuth { k1 } }',
    {},
    'createAuth'
  )
  const k1 = body?.data?.createAuth?.k1
  if (!k1) throw new Error('Failed to create auth challenge: ' + JSON.stringify(body))
  return k1
}

// --- Step 2: Sign Nostr event ---

function createSignedEvent (k1) {
  const { type, data } = nip19.decode(NOSTR_SEC)
  if (type !== 'nsec') throw new Error('Invalid nsec')

  const secretKey = data
  const pubkey = getPublicKey(secretKey)

  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['challenge', k1],
      ['u', SN_URL],
      ['method', 'GET']
    ],
    content: 'Stacker News Authentication'
  }, secretKey)

  return { event, pubkey }
}

// --- Step 3: Get CSRF token ---

async function getCsrfToken () {
  const res = await snFetch('/api/auth/csrf')
  const body = await res.json()
  if (!body?.csrfToken) throw new Error('Failed to get CSRF token')
  return body.csrfToken
}

// --- Step 4: Authenticate via Nostr callback ---

async function authenticate (signedEvent) {
  const csrfToken = await getCsrfToken()

  const params = new URLSearchParams()
  params.append('csrfToken', csrfToken)
  params.append('event', JSON.stringify(signedEvent))
  params.append('callbackUrl', SN_URL)
  params.append('json', 'true')

  const res = await snFetch('/api/auth/callback/nostr', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params
  })

  const body = await res.json()
  if (res.ok && body?.url) return
  throw new Error('Auth callback failed: ' + JSON.stringify(body))
}

// --- Step 5: Query user info ---

async function fetchMe () {
  const body = await gql(
    'query me { me { name } }',
    {},
    'me'
  )
  const name = body?.data?.me?.name
  if (!name) throw new Error('Failed to get user name: ' + JSON.stringify(body))
  return name
}

// --- Step 6: Find all previous posts ---

async function getPreviousPosts (name) {
  console.log(`Querying posts for user @${name}...`)
  const body = await gql(
    `query items($name: String) {
      items(name: $name, sort: "user", limit: 200) {
        items { title, id }
      }
    }`,
    { name },
    'items'
  )
  if (!body?.data?.items) {
    console.error('Unexpected GraphQL response in getPreviousPosts:', JSON.stringify(body, null, 2))
    return []
  }
  const items = body.data.items.items || []
  console.log(`Fetched ${items.length} items total`)
  const escaped = TITLE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`^${escaped}\\s+#(\\d+)$`)
  const matching = items.filter(item => regex.test(item.title))
  console.log(`Found ${matching.length} matching series posts`)
  matching.sort((a, b) => {
    const numA = parseInt(a.title.match(regex)[1], 10)
    const numB = parseInt(b.title.match(regex)[1], 10)
    return numB - numA
  })
  if (matching.length > 0) {
    console.log(`Latest series post: #${matching[0].title.match(regex)[1]} (id ${matching[0].id})`)
  }
  return matching
}

// --- Step 7: Fetch participants from previous post ---

async function fetchParticipants (itemId) {
  const body = await gql(
    `query item($id: ID!) {
      item(id: $id) {
        comments(sort: "sats") {
          comments {
            id
            sats
            user { name }
            text
          }
        }
      }
    }`,
    { id: itemId },
    'item'
  )
  const comments = body?.data?.item?.comments?.comments
  if (!comments || comments.length === 0) return { userNames: [] }
  const userNames = [...new Set(comments.map(c => c.user.name))]
  return { userNames }
}

// --- Step 8: Pin/unpin in territory ---

async function fetchPins (subName) {
  const body = await gql(
    `query items($sub: String) {
      items(sub: $sub, limit: 1) {
        pins { id, title }
      }
    }`,
    { sub: subName },
    'items'
  )
  return body?.data?.items?.pins || []
}

async function togglePin (itemId) {
  const body = await gql(
    'mutation pinItem($id: ID!) { pinItem(id: $id) { id } }',
    { id: itemId },
    'pinItem'
  )
  if (body?.errors) {
    throw new Error('Pin toggle failed: ' + JSON.stringify(body.errors))
  }
}

// --- Step 9: Create the post ---

async function createPost (title, text) {
  const body = await gql(
    `mutation upsertDiscussion($title: String!, $text: String, $subNames: [String!]) {
      upsertDiscussion(title: $title, text: $text, subNames: $subNames) {
        id
        item { id }
      }
    }`,
    { title, text, subNames: [SUB] },
    'upsertDiscussion'
  )
  if (body?.errors) {
    throw new Error('Post creation failed: ' + JSON.stringify(body.errors))
  }
  return body?.data?.upsertDiscussion
}

// --- Main ---

async function main () {
  console.log('Creating auth challenge...')
  const k1 = await createAuthChallenge()

  const { event: signedEvent, pubkey } = createSignedEvent(k1)
  console.log(`Authenticating as ${pubkey.slice(0, 16)}...`)

  await authenticate(signedEvent)

  console.log('Fetching user info...')
  const name = await fetchMe()

  console.log('Finding all previous posts...')
  const posts = await getPreviousPosts(name)

  const escaped = TITLE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`^${escaped}\\s+#(\\d+)$`)
  const issueNum = posts.length > 0 ? parseInt(posts[0].title.match(regex)[1], 10) : 0
  const prevItemId = posts.length > 0 ? posts[0].id : FIRST_POST_ID

  const title = TITLE_PREFIX

  // Fetch participants from previous post
  let userNames = []
  if (prevItemId) {
    try {
      const result = await fetchParticipants(prevItemId)
      userNames = result.userNames.filter(n => n !== 'deSign_r')
      if (userNames.length > 0) {
        console.log(`Participants (${userNames.length}): ${formatNames(userNames)}`)
      }
    } catch (e) {
      console.warn('Could not fetch participants:', e.message)
    }
  }

  const imageMd = pickRandomImage()
  const text = buildText(prevItemId, userNames, imageMd)

  console.log(`Title: ${title}`)
  console.log(`---\n${text}\n---`)
  if (imageMd) {
    console.log(`Random image: ${imageMd}`)
  }

  if (DRY_RUN) {
    console.log('DRY RUN — post not created')
    return
  }

  const result = await createPost(title, text)
  const itemId = result?.item?.id
  console.log('Post created:', JSON.stringify(result, null, 2))
  console.log(`View at: ${SN_URL}/~/${SUB}`)

  if (itemId) {
    console.log('Checking for previously pinned items...')
    const pins = await fetchPins(SUB)
    const seriesPins = pins.filter(pin => pin.title?.startsWith(TITLE_PREFIX))
    for (const pin of seriesPins) {
      if (pin.id !== itemId) {
        console.log(`Unpinning previous series item ${pin.id}...`)
        await togglePin(pin.id)
      }
    }
    console.log(`Pinning new item ${itemId}...`)
    await togglePin(itemId)
    console.log('Pin complete')
  }
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
