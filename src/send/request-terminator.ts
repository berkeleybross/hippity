/**
 * @file Originally copied from Axios under MIT license and subsequently significantly changed
 */

import { isStream, isArrayBuffer, isArrayBufferView } from '../body/body-types'
import { HippityRequest, HippityResponse } from '../client'
import { createError, enhanceError } from '../send/createError'
import { isSuccess } from './is-success'

function lazy(factory) {
  let result
  return () => {
    if (typeof result === 'undefined') {
      result = factory()
    }

    return result
  }
}

const httpFactory = lazy(() => require('http'))
const httpsFactory = lazy(() => require('https'))
const zlibFactory = lazy(() => require('zlib'))

function convertToBuffer(request: HippityRequest): Buffer {
  let body = request.body

  if (Buffer.isBuffer(body)) {
    return body
  }

  if (isArrayBufferView(body)) {
    body = body.buffer
  }

  if (isArrayBuffer(body)) {
    return Buffer.from(new Uint8Array(body))
  }

  if (typeof body === 'string') {
    return Buffer.from(body, 'utf-8')
  }

  throw createError('Body must be a string, Buffer, ArrayBuffer or Stream', {
    request,
  })
}

export function requestTerminator(
  request: HippityRequest
): Promise<HippityResponse> {
  const http = httpFactory()
  const https = httpsFactory()
  const { createUnzip } = zlibFactory()

  return new Promise((resolve, reject) => {
    let body = request.body
    const headers = request.headers

    if (body && !isStream(body)) {
      const bodyBuffer = convertToBuffer(request)
      body = bodyBuffer
      headers['content-length'] = bodyBuffer.length.toString()
    }

    const isHttpsRequest = request.url.startsWith('https://')

    const options = {
      method: request.method,
      headers: headers,
      agent: isHttpsRequest ? request.httpsAgent : request.httpAgent,
    }

    const transport = isHttpsRequest ? https : http

    const req = transport.request(request.url, options, (res) => {
      if (req.aborted) {
        return
      }

      // uncompress the response body transparently if required
      let stream = res
      switch (res.headers['content-encoding']) {
        case 'gzip':
        case 'compress':
        case 'deflate':
          stream = res.statusCode === 204 ? stream : stream.pipe(createUnzip())

          // remove the content-encoding in order to not confuse downstream operations
          delete res.headers['content-encoding']
          break
      }

      const response: HippityResponse = {
        success: isSuccess(request.method || '', res.statusCode),
        status: res.statusCode,
        message: res.statusMessage,
        headers: res.headers,
        request: request,
      }

      if (request.responseType === 'stream') {
        response.body = stream
        resolve(response)
      } else {
        const responseBuffer = []
        stream.on('data', (chunk) => responseBuffer.push(chunk))

        stream.on('error', (err) => {
          if (req.aborted) {
            return
          }

          reject(enhanceError(err, { request }))
        })

        stream.on('end', () => {
          let responseData: Buffer | string = Buffer.concat(responseBuffer)
          if (request.responseType !== 'arraybuffer') {
            responseData = responseData.toString(request.responseEncoding)
          }

          response.body = responseData
          resolve(response)
        })
      }
    })

    req.on('error', (err) => {
      if (req.aborted) return
      reject(enhanceError(err, { request }))
    })

    if (typeof request.onAbort === 'function') {
      request.onAbort(() => {
        if (req.aborted) return

        req.abort()
        reject(new Error('Aborted'))
      })
    }

    if (isStream(body)) {
      body
        .on('error', (err) => {
          reject(enhanceError(err, { request }))
        })
        .pipe(req)
    } else {
      req.end(body)
    }
  })
}
