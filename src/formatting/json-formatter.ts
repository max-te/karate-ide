import { parseExpression } from '@babel/parser';
import type { Node, ObjectProperty, Comment } from '@babel/types';

export type FormattingOptions = {
    indentation: string;
};

export function formatJsonIsh(contents: string, options: FormattingOptions): string {
    const ast = parseExpression(contents);
    const formatted = serialize(ast, options);
    return formatted;
}

function serialize(node: Node, options: FormattingOptions): string {
    return addComments(node, serializeInner(node, options));
}

function serializeInner(node: Node, options: FormattingOptions): string {
    if (node.type === 'ObjectExpression') {
        if (node.properties.length === 0) {
            return '{}';
        }
        let contents = node.properties.map(p => serialize(p, options)).join('\n');
        contents = addIndent(contents, options.indentation);
        return `{\n${contents}\n}`;
    } else if (node.type === 'ObjectProperty') {
        return `${serializeObjectKey(node.key)}: ${serialize(node.value, options)},`;
    } else if (node.type === 'ArrayExpression') {
        if (node.elements.length === 0) {
            return '[]';
        }
        let contents = node.elements.map(p => serialize(p, options) + ',').join('\n');
        contents = addIndent(contents, options.indentation);
        return `[\n${contents}\n]`;
    } else if (node.type === 'StringLiteral') {
        return JSON.stringify(node.value);
    } else if (node.type === 'NumericLiteral') {
        if (typeof node.extra?.raw === 'string') {
            let raw = node.extra.raw.trim();
            // Preserve trailing zeroes of floats for BigDecimal types
            if (/^-?[0-9]*(\.[0-9]+)?$/.test(raw)) {
                return raw;
            }
        }
        return JSON.stringify(node.value);
    } else if (node.type === 'BooleanLiteral') {
        return node.value ? 'true' : 'false';
    } else if (node.type === 'NullLiteral') {
        return 'null';
    } else if (node.type === 'Identifier') {
        return JSON.stringify(node.name);
    } else if (typeof node.extra?.raw === 'string') {
        return node.extra.raw;
    } else {
        throw new Error(`Unsupported json node type: ${node.type}`);
    }
}

function serializeObjectKey(key: ObjectProperty['key']): string {
    // TODO call addComments on result
    switch (key.type) {
        case 'Identifier':
            return key.name;
        case 'StringLiteral':
            const hasSpecialChars = /[^a-zA-Z0-9_]/.test(key.value);
            return hasSpecialChars ? JSON.stringify(key.value) : key.value;
        default:
            if (typeof key.extra?.raw === 'string') {
                return key.extra?.raw as string;
            }
            throw new Error(`Unsupported object key type: ${key.type}`);
    }
}

function addComments(key: Node, serialized: string): string {
    let out = '';
    if (key.leadingComments) {
        for (let comment of key.leadingComments) {
            out += serializeComment(comment);
        }
    }
    if (key.innerComments) {
        for (let comment of key.innerComments) {
            out += serializeComment(comment);
        }
    }
    out += serialized;
    if (key.trailingComments) {
        for (let comment of key.trailingComments) {
            out += serializeComment(comment);
        }
    }
    return out;
}

function serializeComment(comment: Comment) {
    switch (comment.type) {
        case 'CommentLine':
            return '//' + comment.value + '\n';
        case 'CommentBlock':
            return '/* ' + comment.value + ' */ ';
    }
}

function addIndent(inner: string, indentation: string): string {
    return inner
        .split('\n')
        .map(line => (line = indentation + line))
        .join('\n');
}
