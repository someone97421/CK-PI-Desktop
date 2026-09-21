#!/usr/bin/env python3
"""通过 Responses 原生工具生图；Python 3.11+，仅标准库。"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import uuid


def options():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--codex-config', action='store_true')
    p.add_argument('--base-url')
    p.add_argument('--model')
    p.add_argument('--api-key-env')
    p.add_argument('--no-auth', action='store_true')
    p.add_argument('--image-model', default='gpt-image-2.5-flare')
    prompt = p.add_mutually_exclusive_group(required=True)
    prompt.add_argument('--prompt')
    prompt.add_argument('--prompt-file', type=Path)
    p.add_argument('--reference-image', type=Path, action='append', default=[], metavar='PATH',
                   help='本地 PNG/JPEG/WebP 参考图；可重复传入，顺序对应提示词中的图 1、图 2')
    p.add_argument('--output-dir', type=Path, required=True)
    p.add_argument('--auto', action='store_true')
    p.add_argument('--timeout', type=float, default=300, help='网络读写超时秒数')
    return p.parse_args()


def configuration(args):
    base, model, key = args.base_url, args.model, None
    if args.codex_config:
        home = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex')
        config = tomllib.loads((home / 'config.toml').read_text(encoding='utf-8'))
        provider = config.get('model_providers', {}).get(config.get('model_provider'), {})
        configured_base = provider.get('base_url')
        # 显式覆盖地址时不把原服务凭据带到新地址。
        same_target = not base or base.rstrip('/') == (configured_base or '').rstrip('/')
        base = base or configured_base
        model = model or config.get('model')
        if same_target and not args.no_auth:
            env_name = provider.get('env_key')
            key = os.environ.get(env_name) if env_name else None
            key = key or provider.get('experimental_bearer_token')
            auth_path = home / 'auth.json'
            if not key and auth_path.exists():
                key = json.loads(auth_path.read_text(encoding='utf-8')).get('OPENAI_API_KEY')
    if args.api_key_env and not args.no_auth:
        key = os.environ.get(args.api_key_env)
        if not key:
            raise ValueError('指定的凭据环境变量为空')
    elif not args.codex_config and not args.no_auth:
        key = os.environ.get('OPENAI_API_KEY')
    if args.no_auth:
        key = None
    if not base or not model:
        raise ValueError('需要 API base URL 和主对话模型；请显式传入或配置 Codex 自定义提供商')
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('base URL 必须是无内嵌凭据的 HTTP(S) 地址')
    if parsed.query or parsed.fragment:
        raise ValueError('请用不带 query 或 fragment 的 API 根地址')
    endpoint = base.rstrip('/')
    if not endpoint.endswith('/responses'):
        endpoint += '/responses'
    return endpoint, model, key


def reference_input(prompt, paths):
    if not paths:
        return prompt
    content = [{'type': 'input_text', 'text': prompt}]
    for index, path in enumerate(paths, start=1):
        path = path.expanduser()
        if not path.is_file():
            raise ValueError(f'参考图 {index} 不是可读取的本地文件：{path}')
        raw = path.read_bytes()
        if raw.startswith(b'\x89PNG\r\n\x1a\n'):
            mime = 'image/png'
        elif raw.startswith(b'\xff\xd8\xff'):
            mime = 'image/jpeg'
        elif raw.startswith(b'RIFF') and raw[8:12] == b'WEBP':
            mime = 'image/webp'
        else:
            raise ValueError(f'参考图 {index} 格式无法识别，请使用 PNG/JPEG/WebP：{path}')
        encoded = base64.b64encode(raw).decode('ascii')
        content.append({'type': 'input_image', 'image_url': f'data:{mime};base64,{encoded}'})
    return [{'role': 'user', 'content': content}]


def sse_events(response):
    parts = []
    for raw in response:
        line = raw.decode('utf-8').rstrip('\r\n')
        if not line:
            if parts:
                data = '\n'.join(parts)
                parts = []
                if data == '[DONE]':
                    return
                yield json.loads(data)
        elif line.startswith('data:'):
            parts.append(line[5:].lstrip(' '))
    if parts and '\n'.join(parts) != '[DONE]':
        yield json.loads('\n'.join(parts))


class Results:
    def __init__(self, output):
        self.output = output
        self.seen = set()
        self.report = {'status': 'running', 'events': {}, 'images': []}

    def image(self, item):
        if item.get('type') != 'image_generation_call' or not item.get('result'):
            return
        raw = base64.b64decode(item['result'], validate=True)
        ident = item.get('id') or hashlib.sha256(raw).hexdigest()
        if ident in self.seen:
            return
        if raw.startswith(b'\x89PNG\r\n\x1a\n'):
            ext = 'png'
        elif raw.startswith(b'\xff\xd8\xff'):
            ext = 'jpg'
        elif raw.startswith(b'RIFF') and raw[8:12] == b'WEBP':
            ext = 'webp'
        else:
            raise ValueError('返回数据不是可识别的 PNG/JPEG/WebP 图片')
        path = self.output / f'image-{uuid.uuid4().hex[:12]}.{ext}'
        with path.open('xb') as f:
            f.write(raw)
        self.seen.add(ident)
        self.report['images'].append({'path': str(path.resolve()), 'bytes': len(raw)})

    def response(self, response):
        for item in response.get('output', []):
            self.image(item)
        if response.get('status'):
            self.report['response_status'] = response['status']
        if response.get('error'):
            self.report['error'] = response['error']
        if response.get('incomplete_details'):
            self.report['incomplete_details'] = response['incomplete_details']

    def event(self, event):
        kind = event.get('type', 'unknown')
        events = self.report['events']
        events[kind] = events.get(kind, 0) + 1
        if kind == 'response.output_item.done':
            self.image(event.get('item', {}))
        if isinstance(event.get('response'), dict):
            self.response(event['response'])
        if kind in ('response.completed', 'response.failed', 'response.incomplete'):
            self.report['response_status'] = kind.split('.', 1)[1]
        if kind == 'error':
            self.report['error'] = event.get('error') or event.get('message') or '服务端错误事件'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # 避免带凭据的 POST 被重定向到另一服务。
        return None


def main():
    args = options()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    result = Results(args.output_dir)
    key = None
    try:
        endpoint, model, key = configuration(args)
        prompt = args.prompt if args.prompt is not None else args.prompt_file.read_text(encoding='utf-8')
        if not prompt.strip():
            raise ValueError('提示词不能为空')
        tool = {'type': 'image_generation'}
        if args.image_model != 'default':
            tool['model'] = args.image_model
        body = {'model': model, 'input': reference_input(prompt, args.reference_image), 'tools': [tool], 'tool_choice': 'auto' if args.auto else {'type': 'image_generation'}, 'stream': True, 'store': False}
        result.report.update(model=model, image_model=args.image_model, reference_image_count=len(args.reference_image))
        headers = {'Content-Type': 'application/json', 'Accept': 'text/event-stream'}
        if key:
            headers['Authorization'] = 'Bearer ' + key
        req = urllib.request.Request(endpoint, data=json.dumps(body).encode('utf-8'), headers=headers)
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=args.timeout) as response:
            result.report['http_status'] = response.status
            if 'application/json' in response.headers.get('Content-Type', ''):
                result.response(json.load(response))
            else:
                for event in sse_events(response):
                    result.event(event)
        complete = result.report.get('response_status') == 'completed'
        result.report['status'] = 'success' if complete and result.report['images'] and not result.report.get('error') else 'incomplete' if not complete else 'no_image'
        if result.report.get('error'):
            result.report['status'] = 'error'
    except urllib.error.HTTPError as exc:
        result.report.update(status='http_error', http_status=exc.code, error=exc.read(4096).decode('utf-8', errors='replace'))
    except Exception as exc:
        result.report.update(status='error', error=str(exc))
    serialized = json.dumps(result.report, ensure_ascii=False, indent=2)
    if key:
        serialized = serialized.replace(key, '[REDACTED]').replace(json.dumps(key)[1:-1], '[REDACTED]')
    (args.output_dir / 'generation-report.json').write_text(serialized, encoding='utf-8')
    print(serialized)
    return 0 if result.report['status'] == 'success' else 1


if __name__ == '__main__':
    sys.exit(main())
