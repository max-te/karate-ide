/**
 * Below formatting code is adapted from the Cucumber (Gherkin) Full Support extension by Alexander Krechnik.
 * 
 * The original codes' license notice follows:
    MIT License

    Copyright (c) 2018 Alexander Krechik

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
 * 
 */

import {
    CancellationToken,
    DocumentFormattingEditProvider,
    DocumentRangeFormattingEditProvider,
    FormattingOptions,
    Position,
    ProviderResult,
    Range,
    TextDocument,
    TextEdit,
    workspace,
} from 'vscode';
import * as jsonic from 'jsonic';
import { formatJsonIsh } from './json-formatter';
import { parseExpression } from '@babel/parser';

type FormatConfVal = number | 'relative' | 'relativeUp' | 'relativeDown';

interface FormatConf {
    [key: string]: FormatConfVal;
}

interface ResolvedFormat {
    symbol: string;
    value: FormatConfVal;
}

const FORMAT_CONF: FormatConf = {
    ['Ability']: 0,
    ['Business Need']: 0,
    ['Feature:']: 0,
    ['Rule:']: 1,
    ['Scenario:']: 1,
    ['Example:']: 1,
    ['Background:']: 1,
    ['Scenario Outline:']: 1,
    ['Examples:']: 2,
    ['Given']: 2,
    ['When']: 2,
    ['Then']: 2,
    ['And']: 2,
    ['But']: 2,
    ['\\*']: 2,
    ['\\|']: 3,
    ['"""']: 3,
    ['#']: 'relative',
    ['@']: 'relativeDown',
};

const cjkRegex = /[\u3000-\u9fff\uac00-\ud7af\uff01-\uff60]/g;

function findIndentation(line: string, settings: Settings): FormatConfVal | null {
    const format = findFormat(line, settings);
    return format ? format.value : null;
}

function findFormat(line: string, settings: Settings): ResolvedFormat | null {
    const settingsFormatConf = settings.formatConfOverride || {};
    const fnFormatFinder = (conf: FormatConf): ResolvedFormat | null => {
        const symbol = Object.keys(conf).find(key => !!~line.search(new RegExp(escapeRegExp('^\\s*' + key))));
        return symbol ? { symbol, value: conf[symbol] } : null;
    };
    const settingsFormat = fnFormatFinder(settingsFormatConf);
    const presetFormat = fnFormatFinder(FORMAT_CONF);
    return settingsFormat === null ? presetFormat : settingsFormat;
}

export function clearText(text: string) {
    //Remove all the unnecessary spaces in the text
    return text
        .split(/\r?\n/g)
        .map((line, i, textArr) => {
            //Return empty string if it contains from spaces only
            if (~line.search(/^\s*$/)) return '';
            //Remove spaces in the end of string
            line = line.replace(/\s*$/, '');
            return line;
        })
        .join('\r\n');
}

export function correctIndents(text: string, indent: string, settings: Settings) {
    let commentsMode = false;
    const defaultIndentation = 0;
    let insideRule = false;
    const ruleValue = findFormat('Rule:', settings).value;
    const ruleIndentation = typeof ruleValue === 'number' ? ruleValue : 0;
    return text
        .split(/\r?\n/g)
        .map((line, i, textArr) => {
            //Lines, that placed between comments, should not be formatted
            if (settings.skipDocStringsFormat) {
                if (~line.search(/^\s*'''\s*/) || ~line.search(/^\s*"""\s*/)) {
                    commentsMode = !commentsMode;
                } else {
                    if (commentsMode === true) return line;
                }
            }
            //Now we should find current line format
            const format = findFormat(line, settings);
            if (format && format.symbol === 'Rule:') {
                insideRule = true;
            }
            let indentCount;
            if (~line.search(/^\s*$/)) {
                indentCount = 0;
            } else if (format && typeof format.value === 'number') {
                indentCount = format.value + (insideRule && format.symbol !== 'Rule:' ? ruleIndentation : 0);
            } else {
                // In case of 'relativeUp' format option - look for the nearest previous string with some numeric indentation
                // In case of 'relative' or unknown option - look for the nearest next string with some numeric indentation
                const nextOrPrevLines =
                    format && format.value === 'relative'
                        ? interleaveArrays(
                              textArr.slice(i + 1).filter(l => findFormat(l, settings)?.value !== 'relative'),
                              textArr
                                  .slice(0, i)
                                  .reverse()
                                  .filter(l => findFormat(l, settings)?.value !== 'relative'),
                          )
                        : format && format.value === 'relativeUp'
                          ? textArr.slice(0, i).reverse()
                          : textArr.slice(i + 1);
                const nextOrPrevLine = nextOrPrevLines.find(l => typeof findIndentation(l, settings) === 'number');

                if (nextOrPrevLine) {
                    const nextLineIndentation = findIndentation(nextOrPrevLine, settings);
                    indentCount = nextLineIndentation === null ? defaultIndentation : nextLineIndentation;
                } else {
                    indentCount = defaultIndentation;
                }

                indentCount += insideRule ? ruleIndentation : 0;
            }
            return line.replace(/^\s*/, indent.repeat(indentCount));
        })
        .join('\r\n');
}

interface Block {
    line: number;
    block: number;
    data: string[];
}

function formatTables(text) {
    let blockNum = 0;
    let textArr = text.split(/\r?\n/g);

    //Get blocks with data in cucumber tables
    const blocks: Block[] = textArr.reduce((res, l, i, arr) => {
        if (~l.search(/^\s*\|.*\|/)) {
            res.push({
                line: i,
                block: blockNum,
                data: l
                    .split('|')
                    .slice(1, -1)
                    .reduce(
                        (acc, curr) =>
                            (prev => (prev && prev.endsWith('\\') ? [...acc.slice(0, acc.length - 1), prev + '|' + curr] : [...acc, curr]))(
                                acc.slice(-1)[0],
                            ),
                        [],
                    )
                    .map(cell => cell.trim()),
            });
        } else {
            if (!~l.search(/^\s*#/)) {
                blockNum++;
            }
        }
        return res;
    }, []);

    //Get max value for each table cell
    const maxes = blocks.reduce((res, b) => {
        const block = b.block;
        if (res[block]) {
            res[block] = res[block].map((v, i) => Math.max(v, stringBytesLen(b.data[i])));
        } else {
            res[block] = b.data.map(v => stringBytesLen(v));
        }
        return res;
    }, []);

    //Change all the 'block' lines in our document using correct distance between words
    blocks.forEach(block => {
        let change = block.data.map((d, i) => ` ${d}${' '.repeat(maxes[block.block][i] - stringBytesLen(d))} `).join('|');
        change = `|${change}|`;
        textArr[block.line] = textArr[block.line].replace(/\|.*/, change);
    });

    return textArr.join('\r\n');
}

async function formatJson(textBody: string, indent: string) {
    let rxTextBlock = /^\s*""".*$([\s\S.]*?)"""/gm;
    let rxQuoteBegin = /"""/gm;

    let textArr = textBody.match(rxTextBlock);

    if (textArr === null) {
        return textBody;
    }

    for (let txt of textArr) {
        let header = txt.match(rxQuoteBegin)[0];
        let preJson = txt.replace(rxQuoteBegin, '');
        let taggedMap = {};
        let taggedTexts;
        while ((taggedTexts = /<.*?>/g.exec(preJson)) !== null) {
            taggedTexts.forEach(function (tag, index) {
                let uuid = createUUID();

                taggedMap[uuid] = tag;
                preJson = preJson.replace(tag, uuid);
            });
        }

        let rxIndentTotal = /^([\s\S]*?)"""/;
        let textIndentTotal = txt.match(rxIndentTotal);
        let textIndent = textIndentTotal[0].replace(rxQuoteBegin, '').replace(/\n/g, '');

        let jsonTxt = preJson;
        try {
            jsonTxt = formatJsonIsh(preJson, { indentation: indent });
        } catch (e) {
            continue;
        }

        jsonTxt = '\n' + header + '\n' + jsonTxt + '\n"""';
        jsonTxt = jsonTxt.replace(/^/gm, textIndent);

        // Restore tagged json
        for (let uuid in taggedMap) {
            if (taggedMap.hasOwnProperty(uuid)) {
                jsonTxt = jsonTxt.replace(uuid, taggedMap[uuid]);
            }
        }
        textBody = textBody.replace(txt, jsonTxt);
    }
    return textBody;
}

function createUUID() {
    return Math.floor(Math.random() * 1000000000).toString();
}

// Consider a CJK character is 2 spaces
function stringBytesLen(str: string) {
    return str.length + (str.match(cjkRegex) || []).length;
}

export async function format(indent: string, text: string, settings: Settings): Promise<string> {
    //Insert correct indents for all the lined differs from string start
    text = correctIndents(text, indent, settings);

    //We should format all the tables present
    text = formatTables(text);

    // JSON beautifier
    text = await formatJson(text, indent);

    return text;
}

function escapeRegExp(str: string): string {
    // 'Escape' symbols would be ignored by `new RegExp`, but will allow to skip errors
    return str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, '$&');
}

interface Settings {
    skipDocStringsFormat?: boolean;
    formatConfOverride?: FormatConf[];
}

export class GherkinDocumentFormatter implements DocumentFormattingEditProvider, DocumentRangeFormattingEditProvider {
    async provideDocumentFormattingEdits(document: TextDocument, options: FormattingOptions, token: CancellationToken): Promise<TextEdit[]> {
        const text = document.getText();
        const textArr = text.split(/\r?\n/g);
        const indent = getIndent(options);
        const range = new Range(new Position(0, 0), new Position(textArr.length - 1, textArr[textArr.length - 1].length));
        const settings: Settings = { skipDocStringsFormat: true };
        const formattedText = await format(indent, text, settings);
        const clearedText = clearText(formattedText);
        return [TextEdit.replace(range, clearedText)];
    }

    async provideDocumentRangeFormattingEdits(
        document: TextDocument,
        range: Range,
        options: FormattingOptions,
        token: CancellationToken,
    ): Promise<TextEdit[]> {
        const text = document.getText();
        const textArr = text.split(/\r?\n/g);
        const indent = getIndent(options);
        const finalRange = new Range(new Position(range.start.line, 0), new Position(range.end.line, textArr[range.end.line].length));
        const finalText = textArr.splice(finalRange.start.line, finalRange.end.line - finalRange.start.line + 1).join('\r\n');
        const settings: Settings = { skipDocStringsFormat: true };
        const formattedText = await format(indent, finalText, settings);
        const clearedText = clearText(formattedText);
        return [TextEdit.replace(finalRange, clearedText)];
    }
}

function getIndent(options: FormattingOptions): string {
    const { insertSpaces, tabSize } = options;
    return insertSpaces ? ' '.repeat(tabSize) : '\t';
}

function interleaveArrays<T>(array1: T[], array2: T[]): T[] {
    const result = [];
    for (let i = 0; i < Math.max(array1.length, array2.length); i++) {
        if (i < array1.length) {
            result.push(array1[i]);
        }
        if (i < array2.length) {
            result.push(array2[i]);
        }
    }
    return result;
}
