import assert from 'node:assert/strict'
import { isValidVideoId, parseVideoUrl, videoEmbedSrc } from '@linyup/shared'

// The ONE YouTube/Vimeo parser (shared utils/videoEmbed.ts). The publish
// sanitizer trusts `isValidVideoId`, and the renderer interpolates the id into
// a player URL — so what this accepts is what can reach a public iframe.

describe('videoEmbed — parseVideoUrl', () => {
  const yt = { provider: 'youtube', videoId: 'dQw4w9WgXcQ' }
  const vimeo = { provider: 'vimeo', videoId: '1113155200' }

  it('reads the YouTube forms people paste', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ]) {
      assert.deepEqual(parseVideoUrl(url), yt, url)
    }
  })

  it('reads the Vimeo forms people paste', () => {
    for (const url of [
      'https://vimeo.com/1113155200',
      'https://vimeo.com/channels/staffpicks/1113155200',
      'https://player.vimeo.com/video/1113155200?h=abc',
    ]) {
      assert.deepEqual(parseVideoUrl(url), vimeo, url)
    }
  })

  it('refuses anything that is not a YouTube or Vimeo film', () => {
    for (const url of [
      'not a url',
      'https://evil.example/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=short',
      'https://vimeo.com/about',
      'javascript:alert(1)',
    ]) {
      assert.equal(parseVideoUrl(url), null, url)
    }
  })
})

describe('videoEmbed — ids and player URLs', () => {
  it('validates ids per provider', () => {
    assert.equal(isValidVideoId('youtube', 'dQw4w9WgXcQ'), true)
    assert.equal(isValidVideoId('vimeo', 'dQw4w9WgXcQ'), false)
    assert.equal(isValidVideoId('vimeo', '1113155200'), true)
    assert.equal(isValidVideoId('youtube', '"><script>'), false)
  })

  it('builds the privacy-friendly player addresses', () => {
    assert.equal(
      videoEmbedSrc('youtube', 'dQw4w9WgXcQ'),
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=0&rel=0'
    )
    assert.equal(
      videoEmbedSrc('vimeo', '1113155200', { autoplay: true }),
      'https://player.vimeo.com/video/1113155200?autoplay=1&dnt=1'
    )
  })
})
