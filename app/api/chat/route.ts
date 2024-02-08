import { kv } from '@vercel/kv'
import { OpenAIStream, StreamingTextResponse } from 'ai'
import OpenAI from 'openai'

import { auth } from '@/auth'
import { nanoid } from '@/lib/utils'

export const runtime = 'edge'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const queryIonic = async (query: string) => {
  console.log({ query })
  const res = await fetch('https://api.ioniccommerce.com/gpt/query', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: { query, num_results: 10 } })
  })
  const data = await res.json();
  return JSON.stringify(data)
}

export async function POST(req: Request) {
  const json = await req.json()
  const { messages, previewToken } = json
  const userId = (await auth())?.user.id

  if (!userId) {
    return new Response('Unauthorized', {
      status: 401
    })
  }

  if (previewToken) {
    openai.apiKey = previewToken
  }

  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo-0125",
    messages: messages,
    tools: [
      {
        type: "function",
        function: {
          name: "query_ionic",
          description: "Use this function to search for products and to get product recommendations.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "A precise query of a product name or product category",
              },
            },
            required: ["query"],
          },
        },
      },
    ],
    tool_choice: "auto", // auto is default, but we'll be explicit
  });
  const responseMessage = response.choices[0].message;

  // Step 2: check if the model wanted to call a function
  const toolCalls = responseMessage.tool_calls;
  if (toolCalls) {
    // Step 3: call the function
    // Note: the JSON response may not always be valid; be sure to handle errors
    const availableFunctions = {
      query_ionic: queryIonic,
    }; // only one function in this example, but you can have multiple
    messages.push(responseMessage); // extend conversation with assistant's reply
    for (const toolCall of toolCalls) {
      const functionName = toolCall.function.name;
      const functionToCall = availableFunctions[functionName];
      const functionArgs = JSON.parse(toolCall.function.arguments);
      console.log({ functionName, functionArgs })
      const functionResponse = await functionToCall(functionArgs.query);
      console.log({ functionResponse })
      messages.push({
        tool_call_id: toolCall.id,
        role: "tool",
        name: functionName,
        content: functionResponse,
      }); // extend conversation with function response
    }
  }

  const res = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo-0125',
    messages,
    temperature: 0.7,
    stream: true,
  })

  const stream = OpenAIStream(res, {
    async onCompletion(completion) {
      // const choice = json.choices[0]
      // console.log({ choice })
      const title = json.messages[0].content.substring(0, 100)
      const id = json.id ?? nanoid()
      const createdAt = Date.now()
      const path = `/chat/${id}`
      const payload = {
        id,
        title,
        userId,
        createdAt,
        path,
        messages: [
          ...messages,
          {
            content: completion,
            role: 'assistant'
          }
        ]
      }
      await kv.hmset(`chat:${id}`, payload)
      await kv.zadd(`user:chat:${userId}`, {
        score: createdAt,
        member: `chat:${id}`
      })
    }
  })

  return new StreamingTextResponse(stream)
}
