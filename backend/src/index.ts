import axios, { all } from "axios";
import * as cheerio from 'cheerio';
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ChromaClient, Metadata } from "chromadb";
import readline from "node:readline";
import { stdin, stdout } from "node:process";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);

const model = genAI.getGenerativeModel({ model: "text-embedding-004" });

const chatModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

let allLinks: string[] | null = null;

const chromaClient = new ChromaClient({ path: "http://localhost:8000" });
chromaClient.heartbeat();

const WEB_COLLECTION = 'WEB_COLLECTION_1';

const rl = readline.createInterface({ input: stdin, output: stdout });

async function webScrappingOfPage(url: string = "") {
    try {
        const { data } = await axios.get(url);

        const $ = cheerio.load(data);

        const head = $("head").html();
        const body = $("body").html();
        let internalLinks = new Set<string>();
        let externalLinks = new Set<string>();

        const links = $("a")

        links.each((_, el) => {
            const href = $(el).attr("href");
            if (href === "/" || !href) return;

            const resolvedURL = new URL(href, url).href;

            if (resolvedURL.startsWith(url)) {
                internalLinks.add(resolvedURL);
            } else {
                externalLinks.add(resolvedURL);
            }
        });

        if (!allLinks) {
            allLinks = [...Array.from(internalLinks)]
        }

        return { head, body }
    } catch (err) {
        console.log(`Something went wrong: ${err}`);
        return { head: null, body: null }
    }
}

function chunkText(text: string, chunkSize: number) {
    if (!text || chunkSize <= 0) return [];

    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
}


async function generateVectorEmbeddingsOfData({ text }: { text: string }) {
    const encoder = new TextEncoder();

    const byteLength = encoder.encode(text).length;

    if (byteLength > 10000) {
        console.error(`Chunk exceeds byte limit: ${byteLength}`);
        throw new Error("Chunk exceeds byte limit");
    }


    try {
        const result = await model.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        console.error("Error embedding content:", error);
        throw error;
    }
}


async function insert(url: string = "") {
    const { head, body } = await webScrappingOfPage(url);

    if (!head || !body) return;

    const headChunks = chunkText(head, 2500);
    const bodyChunks = chunkText(body, 2500);

    for (let chunk of headChunks) {
        if (chunk.trim() === "") continue;

        const headEmbeddings = await generateVectorEmbeddingsOfData({ text: chunk });

        const collection = await chromaClient.getOrCreateCollection({
            name: WEB_COLLECTION
        });

        await collection.add({
            ids: [url],
            embeddings: [headEmbeddings],
            metadatas: [{ url, head, body }]
        })
    }

    for (let chunk of bodyChunks) {
        if (chunk.trim() === "") continue;

        const bodyEmbeddings = await generateVectorEmbeddingsOfData({ text: chunk });

        const collection = await chromaClient.getOrCreateCollection({
            name: WEB_COLLECTION
        });

        await collection.add({
            ids: [url],
            embeddings: [bodyEmbeddings],
            metadatas: [{ url, head, body }]
        })
    }
}

async function startDataFeeding(url = "") {
    await insert(url);
    if (!allLinks) return;
    for (let link of allLinks) {
        await insert(link);
    }
}

async function startTakingPrompt() {
    rl.question("Prompt:=> ", async function (prompt) {
        if (prompt.toLocaleLowerCase() == "exit") {
            rl.close();
            return;
        }

        const questionEmbedding = await generateVectorEmbeddingsOfData({ text: prompt });

        const collection = await chromaClient.getOrCreateCollection({
            name: WEB_COLLECTION
        });

        const collectionResult = await collection.query({
            nResults: 3,
            queryEmbeddings: questionEmbedding
        });

        const head = collectionResult.metadatas[0].map((e: Metadata | any) => e.head).filter((e) => e.trim() !== "" && !!e);

        const body = collectionResult.metadatas[0].map((e: Metadata | any) => e.body).filter((e) => e.trim() !== "" && !!e);

        const url = collectionResult.metadatas[0].map((e: Metadata | any) => e.url).filter((e) => e.trim() !== "" && !!e);

        const chat = chatModel.startChat({
            history: [
                {
                    role: "user",
                    parts: [{
                        text: `
                            {
                        URLs: ${url},
                        head: ${head},
                        body: ${body}
                        }
                        `}]
                },
                {
                    role: "model",
                    parts: [{ text: "You are an AI support agent expect in providing support to user on behalf of a webpage. Given the context about page content, reply the user accordingly" }]
                },
            ]
        })

        const result = await chat.sendMessage(prompt);

        console.log(`🤖: ${result.response.text()},
        urls: ${url[0]}`)
        await startTakingPrompt();
    })
}

async function chat(url = "") {
    if (!url.startsWith("https://") || !url.startsWith("http://")) {
        console.log("😵 Invalid URl...");
        return;
    }
    //(Recommended)It's better if you will copy the link from browser then paste it here
    console.log("🏃‍♂️‍➡️ Model training... start 👍");
    await startDataFeeding(url);
    console.log("🏆 Model trained successfully... 💨");

    await startTakingPrompt();
};

//(Recommended)It's better if you will copy the link from browser and then paste it here
chat("website URL(uniform resource locator")
