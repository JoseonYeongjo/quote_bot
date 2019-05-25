const db = require("./lib/db.js");
const util = require("./lib/util.js");
const discord = require("discord.js");
const fs = require("fs");
const cp = require('child_process');
db.initialize(main);

var auth, config, client;
var commands = {};
function main() {
    console.log("[BOOT] Database connection established.");
    config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
    auth = JSON.parse(fs.readFileSync("./auth.json", "utf8"));
    util.initialize(config);
    configurableCommands();
    console.log("[BOOT] Loaded auth and config.");
    client = new discord.Client();
    coreLogic();
    client.login(auth.token).catch(error=>{
        console.error(error);
        process.exit(1);
    });
}

function coreLogic() {
    client.on('ready', e=>console.log("[BOOT] Signed in to Discord account."));
    client.on('message', (message) => {
        if (message.content.startsWith("!")) {
            let argIndex = message.content.indexOf(" ");
            let cmd = argIndex == -1 ? message.content.substring(1) : message.content.substring(1, argIndex);
            if (cmd in commands) {
                let text = argIndex == -1 ? "" : message.content.substring(argIndex + 1);
                commands[cmd](message, text);
            }
        }
    });
}

// ---------------------------------- CONSTANTS ------------------------------------

const PARTS_OF_SPEECH = ["<p_noun>","<noun>","<trans_verb>","<i_verb>","<adjective>","<article>","<adverb>"];

const RECURSIVE_TOKENS = {
    "<sentence>": ["<simple_sentence>", "<simple_sentence>", "<compound_sentence>"],
    "<simple_sentence>" : ["<noun_phrase> <verb_phrase>"],
    "<compound_sentence>" : ["<simple_sentence> and <simple_sentence>"],
    "<noun_phrase>": ["<article_particle> <adjective_phrase> <noun>", "<p_noun>"],
    "<adjective_phrase>": ["<adjective>", "<adjective>", "<adjective> <adjective_phrase>"],
    "<verb_phrase>": ["<trans_verb_particle> <noun_phrase>", "<i_verb_particle>"],
    "<trans_verb_particle>": ["<trans_verb>", "<adverb> <trans_verb>"],
    "<i_verb_particle>": ["<i_verb>", "<adverb> <i_verb>", "<i_verb> <adverb>"],
    "<article_particle>": ["<article>", "<p_noun>'s"]
};

const VOCAB_WORDS_PER_MESSAGE = 120;

// ------------------- FEATURES (more complex functionality) -----------------------

let produceChart = (channel, users, members, days) => {
    let millisecondsInDay = 86400000;
    db.allLogs(users.map(user => user.id), Date.now() - days * millisecondsInDay, results => {
        let usersToLogs = {};
        for (let row of results) {
            if (usersToLogs[row.nickname] == undefined) usersToLogs[row.nickname] = [];
            usersToLogs[row.nickname].push(Math.floor((Date.now() - row.created_at) / millisecondsInDay));
        }
        let chartfile = days + "\n";
        for (let nickname in usersToLogs) {
            chartfile += nickname + "\n" + usersToLogs[nickname].join(" ") + "\n";
        }
        fs.writeFileSync("./chart/chartdata", chartfile, 'utf8');
        cp.exec("python3 ./chart/chartgen.py ./chart/", (error, stdout, stderr) => {
            if (error) console.error("[chartgen] ERROR: " + error);
            if (stdout) console.log("[chartgen] " + stdout);
            if (stderr) console.error("[chartgen] " + stderr);
            channel.send({
                files: [{
                    attachment: './chart/chart.png',
                    name: 'botchart.png'
                }]
            })
        });
    });
}

let quoteGlossary = null;
let populateQuoteGlossary = (content) => {
    if (!quoteGlossary) quoteGlossary = {};
    util.toWords(content).forEach(word => {
        if (!(word in quoteGlossary)) quoteGlossary[word] = 0;
        quoteGlossary[word]++;
    });
}
let ensureQuoteGlossary = (quotes) => {
    if (!quoteGlossary) {
        quoteGlossary = {};
        quotes.forEach(quote => {
            populateQuoteGlossary(quote.content);
        });
    }
}

let sendQuote = (channel, content, author) => {
    channel.send(config["quote_response"].replace("{q}", content).replace("{u}", author));
}

let vocabCache, vocabUpdate;
let parseCFG = (tk) => {
    return tk.replace(/<[^>]*>/g, function(token) {
        if (token in RECURSIVE_TOKENS) {
            let list = RECURSIVE_TOKENS[token];
            return parseCFG(util.simpleRandom(list));
        }
        let typeID = PARTS_OF_SPEECH.indexOf(token);
        if (typeID > -1) {
            return util.simpleRandom(vocabCache[typeID]);
        }
        return token;
    });
}
let updateVocabCache = (i, callback) => {
    if (i >= PARTS_OF_SPEECH.length) {
        callback();
        return;
    }
    if (i == 0) {
        if (vocabUpdate && Date.now() - vocabUpdate < 20000) {
            callback();
            return;
        }
        vocabCache = [];
        for (let i = 0; i < PARTS_OF_SPEECH.length; i++) {
            vocabCache[i] = [];
        }
    }
    db.fetchVocab(i, vocab => {
        vocabCache[i] = vocab;
        updateVocabCache(i + 1, callback);
    });
}
let getCFGSentence = (callback) => {
    let punct = util.simpleRandom([".", ".", ".", "...", "!"]);
    updateVocabCache(0, () => {
        let raw = parseCFG("<sentence>");
        let final = raw.charAt(0).toUpperCase() + raw.slice(1) + punct;
        callback(final);
    });
}
let sentencesCache = [];
let getCFGSentences = (n, callback, init) => {
    if (!init) sentenceCache = [];
    if (n == 0) {
        callback(sentencesCache);
    } else {
        getCFGSentence(sentence => {
            sentencesCache.push(sentence);
            getCFGSentences(n-1, callback, true);
        });
    }
}








// --------------------- COMMANDS (responses to ! calls) ---------------------------

commands["addquote"] = (message, text) => {
    if(!message.mentions.users.first()) {
        message.channel.send(config["add_quote_error"]);
    } else {
        let content = text.substring(text.indexOf(" ") + 1);
        db.addQuote(message.mentions.users.first().id, content, () => {
            populateQuoteGlossary(content);
            message.react("👍");
        });
    }
}

commands["chart"] = (message, text) => {
    let numDays = parseInt(util.args(text)[0]);
    if (!(numDays > 0 && numDays <= 365)) {
        message.channel.send(config["chart_error"]);
    } else {
        let mentionUsers = message.mentions.users.array(), mentionMembers = message.mentions.members.array();
        if (mentionUsers.length == 0) {
            mentionUsers = [message.author];
            mentionMembers = [message.member];
        }
        produceChart(message.channel, mentionUsers, mentionMembers, numDays);
    }
}

commands["clear"] = (message, text) => {
    util.getPermission(db, message.author.id, "ADMIN", message.channel, () => {
        let count = parseInt(util.args(text)[0]);
        if (count <= 0 || count > 100) {
            message.channel.send(config["clear_error"]);
        } else {
            message.channel.bulkDelete(count + 1).then(messages => {
                message.channel.send(config["clear_response"].replace("{n}", count)).then(message => message.delete(2000));
            });
        }
    });
}

commands["delquotes"] = (message, text) => {
    util.getPermission(db, message.author.id, "ADMIN", message.channel, () => {
        db.deleteQuotes(text, () => {
            message.react("👍");
        });
    });
}

commands["f"] = (message) => {
    util.getPermission(db, message.author.id, "ADMIN", message.channel, () => {
        let member = message.mentions.members.first();
        if (member) {
            let afkChannel = member.guild.channels.find(c=>c.name==config["afk_chat_name"]);
            member.setVoiceChannel(afkChannel);
        }
    });
}

commands["forget"] = (message, text) => {
    let args = util.args(text), pos = "<" + args[0] + ">";
    let typeID = PARTS_OF_SPEECH.indexOf(pos);
    if (args.length < 2 || typeID == -1) {
        message.channel.send(config["forget_error"]);
    } else {
        let vocabType = PARTS_OF_SPEECH.indexOf(pos);
        db.forgetVocab(vocabType, args[1], deletions => {
            if (deletions == 0) {
                message.channel.send(config["forget_repeat_error"]);
            } else {
                message.react("👍");
            }
        });
    }
}

commands["help"] = (message) => {
    fs.readFile('./helpfile', 'utf8', (error, data) => {
        if (error) {
            console.error(error);
            process.exit(1);
        }
        message.channel.send(data);
    });
}

commands["name"] = (message) => {
    let id = message.mentions.users.first() ? message.mentions.users.first().id : message.author.id;
    let displayName = message.mentions.members.first() ? message.mentions.members.first().displayName : message.member.displayName;
    db.quoteName(id, quoteName => {
        if (!quoteName) message.channel.send(config["quote_name_error"]);
        else message.channel.send(config["quote_name_response"].replace("{u}", displayName).replace("{n}", quoteName));
    });
}

commands["numquotes"] = (message, text) => {
    db.filteredQuotes(text, quotes => {
        message.channel.send(config["num_quotes"].replace("{n}", quotes.length));
    });
}

commands["ping"] = (message) => {
    message.channel.send(config["ping_response"]);
}

commands["quote"] = (message, text) => {
    if (text) {
        db.filteredQuotes(text, quotes => {
            if (quotes.length > 0) {
                let quote = util.simpleRandom(quotes);
                sendQuote(message.channel, quote.content, quote.nickname);
            } else {
                message.channel.send(config["quote_error"]);
                return;
            }
        });
    } else {
        let n = config["quote_params"]["relevant_message_count"],
            e = config["quote_params"]["relevant_exponentiation"],
            p = config["quote_params"]["relevant_probability"];
        message.channel.fetchMessages({ limit: n * 10, before: message.id}).then(messages => {
            db.allQuotes(quotes => {
                if (quotes.length == 0) {
                    message.channel.send(config["quote_error"]);
                    return;
                }
                ensureQuoteGlossary(quotes);
                let recentGlossary = {};
                messages = messages.array();
                let count = 0;
                for (let i = 0; i < n; i++) {
                    if (!messages[i].author.bot && !messages[i].content.startsWith("!")) {
                        let words = util.toWords(messages[i].content);
                        if (words.length > 1) {
                            for (let word of words) {
                                if (!(word in recentGlossary)) recentGlossary[word] = 0;
                                recentGlossary[word]++;
                            }
                            if (++count >= n) break;
                        }
                    }
                }
                if (Object.keys(recentGlossary).length == 0) {
                    let quote = util.simpleRandom(quotes);
                    sendQuote(message.channel, quote.content, quote.nickname);
                    return;
                }
                let weightSum = 0.0;
                quotes = quotes.map(quote => {
                    let rank = 0.0;
                    util.toWords(quote.content).forEach(word => {
                        rank += (recentGlossary[word] || 0.0) / quoteGlossary[word];
                    });
                    rank = Math.pow(rank, e);
                    weightSum += rank;
                    return {value: quote, weight: rank};
                }).map(quote => {
                    let processedWeight = p * quote.weight / weightSum + (1 - p) / quotes.length;
                    return {value: quote.value, weight: processedWeight};
                });

                quotes.sort((a,b) => b.weight - a.weight); // sort and report quotes for debug purposes
                for (let i = 0; i < 5; i++) console.log("[relevant_quotes]: " + quotes[i].value.content + ": " + quotes[i].weight);
                let quote = util.weightedRandom(quotes);
                sendQuote(message.channel, quote.content, quote.nickname);
            });
        });
    }
}

commands["setname"] = (message, text) => {
    let user = message.mentions.users.first() || message.author,
        newName = text.substring(text.indexOf(" ") + 1);
    db.updateNickname(user.id, newName, () => {
        message.react("👍");
    });
}

commands["signature"] = (message, text) => {
    let signature = util.args(text)[0];
    db.updateSignature(message.author.id, signature, () => {
        message.react("👍");
    });
}

commands["speak"] = (message, text) => {
    let n = parseInt(util.args(text)[0]);
    if (!(n > 0 && n <= 25)) n = 1;
    getCFGSentences(n, sentences => {
        let output = "";
        for (let sentence of sentences) {
            output += sentence + "\n";
        }
        message.channel.send(output);
    });
}

commands["teach"] = (message, text) => {
    let args = util.args(text), pos = "<" + args[0] + ">";
    let typeID = PARTS_OF_SPEECH.indexOf(pos);
    if (args.length < 2 || typeID == -1) {
        message.channel.send(config["teach_error"]);
    } else {
        let word = text.substring(text.indexOf(" ") + 1);
        db.checkVocab(typeID, word, exists => {
            if (exists) {
                message.channel.send(config["teach_repeat_error"]);
            } else {
                db.addVocab(typeID, word, () => {
                    message.react("👍");
                });
            }
        });
    }
}

commands["undo"] = (message) => {
    util.getPermission(db, message.author.id, "UNDO", message.channel, () => {
        db.deleteLastLog(message.author.id, rowsAffected => {
            if (rowsAffected > 0) {
                message.channel.send(config["undo_response"].replace("{u}", message.member.displayName));
            } else {
                message.channel.send(config["undo_error"]);
            }
        });
    });
}

commands["vocab"] = (message, text) => {
    let args = util.args(text), pos = "<" + args[0] + ">";
    let typeID = PARTS_OF_SPEECH.indexOf(pos);
    if (args.length < 1 || typeID == -1 && args[0] != "all") {
        message.channel.send(config["vocab_error"]);
    } else {
        if (args[1] == "count") {
            db.countVocab(typeID, count => {
                if (args[0] == "all") args[0] = "word";
                message.channel.send(config["vocab_count_response"].replace("{n}", count).replace("{t}", args[0]));
            });
        } else {
            db.fetchVocab(typeID, vocab => {
                vocab.sort();
                for(let i = 0; i < vocab.length / VOCAB_WORDS_PER_MESSAGE; i++) {
                    let vocabSlice = vocab.slice(i * VOCAB_WORDS_PER_MESSAGE, (i + 1) * VOCAB_WORDS_PER_MESSAGE);
                    message.channel.send(vocabSlice.join(", "));
                }
            });
        }
    }
}

commands["when"] = (message, text) => {
    let id = message.mentions.users.first()
            ? message.mentions.users.first().id
            : message.author.id,
        nickname = message.mentions.members.first()
            ? message.mentions.members.first().displayName
            : message.member.displayName;
    db.lastLog(id, (logInfo) => {
        if (logInfo) {
            let duration = util.formatDuration(Date.now() - logInfo.lastLog);
            message.channel.send(config["when_response"].replace("{d}", duration).replace("{u}", nickname).replace("{s}", logInfo.signature));
        } else {
            message.channel.send(config["when_error"].replace("{u}", nickname));
        }
    });
}

let configurableCommands = () => {
    commands[config["log_command"]] = (message, text) => {
        db.addLog(message.author.id, Date.now(), text, () => {
            message.channel.send(config["log_response"].replace("{u}", message.member.displayName));
        });
    }

    for (let cmd in config["plain_responses"]) {
        commands[cmd] = (message, text) => {
            message.channel.send(config["plain_responses"][cmd]);
        }
    }
}
