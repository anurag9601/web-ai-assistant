"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const cheerio = __importStar(require("cheerio"));
const dotenv_1 = __importDefault(require("dotenv"));
const generative_ai_1 = require("@google/generative-ai");
const chromadb_1 = require("chromadb");
const groq_sdk_1 = __importDefault(require("groq-sdk"));
const node_readline_1 = __importDefault(require("node:readline"));
const node_process_1 = require("node:process");
dotenv_1.default.config();
const genAI = new generative_ai_1.GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
const chromaClient = new chromadb_1.ChromaClient({ path: "http://localhost:8000" });
chromaClient.heartbeat();
const WEB_COLLECTION = "WEB_SCRAPED_DATA_COLLECTION-1";
const visitedUrls = new Set();
const gorq = new groq_sdk_1.default({ apiKey: process.env.GROQ_API_KEY });
let allLinks = [];
function webScrappingOfSite() {
    return __awaiter(this, arguments, void 0, function* (url = "") {
        try {
            const { data } = yield axios_1.default.get(url);
            const $ = cheerio.load(data);
            const head = $("head").html();
            const body = $("body").html();
            let pageLinks = new Set();
            $("a").each((_, el) => {
                const href = $(el).attr("href");
                if (!href || href == "/")
                    return;
                const resolvedUrl = new URL(href, url).href;
                if (resolvedUrl.startsWith("http://") || resolvedUrl.startsWith("https://")) {
                    pageLinks.add(resolvedUrl);
                }
            });
            allLinks = [...Array.from(pageLinks)];
            return { head, body, pageLinks: Array.from(pageLinks) };
        }
        catch (err) {
            console.error("Error scraping URL:", url, err);
            return { head: null, body: null, pageLinks: [] };
        }
    });
}
;
function chunkText(text, maxBytes) {
    if (!text)
        return [];
    let chunks = [];
    let currentChunk = "";
    let currentSize = 0;
    for (let word of text.split(/\s+/)) {
        let wordSize = new TextEncoder().encode(word).length;
        if (currentSize + wordSize > maxBytes) {
            chunks.push(currentChunk.trim());
            currentChunk = word;
            currentSize = wordSize;
        }
        else {
            currentChunk += " " + word;
            currentSize += wordSize;
        }
    }
    if (currentChunk)
        chunks.push(currentChunk.trim());
    return chunks;
}
function generateVectorEmbeddings(_a) {
    return __awaiter(this, arguments, void 0, function* ({ text }) {
        const truncatedText = text.substring(0, 9500);
        const result = yield model.embedContent(truncatedText);
        return result.embedding.values;
    });
}
function insertIntoDB(_a) {
    return __awaiter(this, arguments, void 0, function* ({ embedding, url, head, body = "" }) {
        const collection = yield chromaClient.getOrCreateCollection({
            name: WEB_COLLECTION
        });
        yield collection.add({
            ids: [url],
            embeddings: [embedding],
            metadatas: [{ url, head, body }]
        });
    });
}
function ingest(url_1) {
    return __awaiter(this, arguments, void 0, function* (url, depth = 0) {
        if (visitedUrls.has(url))
            return;
        visitedUrls.add(url);
        let { head, body, pageLinks } = yield webScrappingOfSite(url);
        if (!body || !head)
            return;
        const Headchunks = chunkText(head, 100); // it has limit of 1000 bytes...
        const BodyChunks = chunkText(body, 500);
        for (let chunk of Headchunks) {
            const headEmbedding = yield generateVectorEmbeddings({ text: chunk });
            yield insertIntoDB({ embedding: headEmbedding, url, head, body });
        }
        for (let chunk of BodyChunks) {
            const bodyEmbeddings = yield generateVectorEmbeddings({
                text: chunk
            });
            yield insertIntoDB({ embedding: bodyEmbeddings, url, head, body });
        }
    });
}
function chat(question) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const questionEmbedding = yield generateVectorEmbeddings({ text: question });
        const collection = yield chromaClient.getOrCreateCollection({
            name: WEB_COLLECTION
        });
        const collectionResult = yield collection.query({
            nResults: 3,
            queryEmbeddings: questionEmbedding
        });
        const body = collectionResult.metadatas[0].map((e) => e.body).filter((e) => e.trim() !== "" && !!e);
        const head = collectionResult.metadatas[0].map((e) => e.head).filter((e) => e.trim() !== "" && !!e);
        const url = collectionResult.metadatas[0].map((e) => e.url).filter((e) => e.trim() !== "" && !!e);
        const chatCompletion = yield gorq.chat.completions.create({
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
            message: `🤖: ${(_a = chatCompletion.choices[0]) === null || _a === void 0 ? void 0 : _a.message.content}`,
            url: url[0]
        });
    });
}
console.log("allLinks", allLinks);
function trainModel() {
    return __awaiter(this, void 0, void 0, function* () {
        for (let link of allLinks) {
            console.log("link");
            yield ingest(link);
        }
        allLinks = [];
    });
}
const rl = node_readline_1.default.createInterface({ input: node_process_1.stdin, output: node_process_1.stdout });
function startChat() {
    return __awaiter(this, void 0, void 0, function* () {
        yield trainModel();
        rl.question("Prompt:> ", function (prompt) {
            return __awaiter(this, void 0, void 0, function* () {
                if (prompt.toLowerCase() === "exit") {
                    rl.close();
                    return;
                }
                yield chat(prompt);
                startChat();
            });
        });
    });
}
startChat();
