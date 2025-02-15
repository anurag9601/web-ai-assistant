import axios, { all } from "axios";
import * as cheerio from 'cheerio';
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ChromaClient } from "chromadb";
import Groq from "groq-sdk";
import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { link } from "node:fs";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);

const model = genAI.getGenerativeModel({ model: "text-embedding-004" });

const chromaClient = new ChromaClient({ path: "http://localhost:8000" });

chromaClient.heartbeat();

const WEB_COLLECTION = "WEB_SCRAPED_DATA_COLLECTION-1";

const visitedUrls = new Set<string>();

const gorq = new Groq({ apiKey: process.env.GROQ_API_KEY as string });

async function webScrappingOfSite(url: string = "") {
    try {
        const { data } = await axios.get(url);
        const $ = cheerio.load(data);

        const head = $("head").html();
        const body = $("body").html();

        let pageLinks = new Set<string>();

        $("a").each((_, el) => {
            const href = $(el).attr("href");
            if (!href || href == "/") return;

            const resolvedUrl = new URL(href, url).href;

            if (resolvedUrl.startsWith("http://") || resolvedUrl.startsWith("https://")) {
                pageLinks.add(resolvedUrl)
            }
        });

        return { head, body, pageLinks: Array.from(pageLinks) }
    } catch (err) {
        console.error("Error scraping URL:", url, err);
        return { head: null, body: null, pageLinks: [] };
    }
};

function chunkText(text: string, maxBytes: number) {
    if (!text) return [];

    let chunks: string[] = [];
    let currentChunk = "";
    let currentSize = 0;

    for (let word of text.split(/\s+/)) {
        let wordSize = new TextEncoder().encode(word).length;

        if (currentSize + wordSize > maxBytes) {
            chunks.push(currentChunk.trim());
            currentChunk = word;
            currentSize = wordSize;
        } else {
            currentChunk += " " + word;
            currentSize += wordSize;
        }
    }
    if (currentChunk) chunks.push(currentChunk.trim());

    return chunks;
}


async function generateVectorEmbeddings({ text }: { text: string }) {
    const truncatedText = text.substring(0, 9500);
    const result = await model.embedContent(truncatedText);
    return result.embedding.values;
}

async function insertIntoDB({ embedding, url, head, body = "" }: { embedding: number[], url: string, head: string, body: string }) {
    const collection = await chromaClient.getOrCreateCollection({
        name: WEB_COLLECTION
    });

    await collection.add({
        ids: [url],
        embeddings: [embedding],
        metadatas: [{ url, head, body }]
    });
}

async function ingest(url: string, depth = 0) {
    if (visitedUrls.has(url)) return;

    visitedUrls.add(url);

    let { head, body, pageLinks } = await webScrappingOfSite(url);

    if (!body || !head) return;

    const Headchunks = chunkText(head, 100); // it has limit of 1000 bytes...
    const BodyChunks = chunkText(body, 500);

    for (let chunk of Headchunks) {
        const headEmbedding = await generateVectorEmbeddings({ text: chunk });
        await insertIntoDB({ embedding: headEmbedding, url, head, body });
    }


    for (let chunk of BodyChunks) {
        const bodyEmbeddings = await generateVectorEmbeddings({
            text: chunk
        });
        await insertIntoDB({ embedding: bodyEmbeddings, url, head, body });
    }
}

async function chat(question: string) {
    const questionEmbedding = await generateVectorEmbeddings({ text: question });

    const collection = await chromaClient.getOrCreateCollection({
        name: WEB_COLLECTION
    });

    const collectionResult = await collection.query({
        nResults: 3,
        queryEmbeddings: questionEmbedding
    });

    const body = collectionResult.metadatas[0].map((e: any) => e.body).filter((e) => e.trim() !== "" && !!e);

    const head = collectionResult.metadatas[0].map((e: any) => e.head).filter((e) => e.trim() !== "" && !!e);

    const url = collectionResult.metadatas[0].map((e: any) => e.url).filter((e) => e.trim() !== "" && !!e);

    const chatCompletion = await gorq.chat.completions.create({
        messages: [
            {
                role: "system",
                content: "You are an AI support agent expert in providing support to users on behalf of a webpage. Given the context about page content, reply the user accordingly"
            },
            {
                role: "user",
                content: `
                {
                    Query: ${question},
                    URLs: ${url},
                    Retrived_Head_Context: ${head},
                    Retrived_Body_Context: ${body},
                }
                `
            }
        ],
        model: "llama-3.3-70b-versatile"
    });

    console.log({
        message: `🤖: ${chatCompletion.choices[0]?.message.content}`,
        url: url[0]
    })
}

const rl = readline.createInterface({ input: stdin, output: stdout });

async function startChat() {
    rl.question("Prompt:> ", async function (prompt) {
        if (prompt.toLowerCase() === "exit") {
            rl.close();
            return;
        }
        await chat(prompt);
        startChat()
    })
}

ingest("https://console.groq.com")
startChat();

