/// Quotes a single Windows command-line argument according to `CommandLineToArgvW` rules.
pub fn quote_windows_arg(value: &str) -> String {
    if !value.is_empty() && !value.chars().any(|c| matches!(c, ' ' | '\t' | '\n' | '\x0b' | '"')) {
        return value.to_string();
    }
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for ch in value.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                for _ in 0..(backslashes * 2 + 1) {
                    out.push('\\');
                }
                out.push('"');
                backslashes = 0;
            }
            _ => {
                for _ in 0..backslashes {
                    out.push('\\');
                }
                backslashes = 0;
                out.push(ch);
            }
        }
    }
    for _ in 0..(backslashes * 2) {
        out.push('\\');
    }
    out.push('"');
    out
}

/// Builds the full `lpCommandLine` string for `CreateProcessW` / `CreateProcessAsUserW`.
/// When `raw_tail` is provided (e.g. `cmd.exe` verbatim `/d /v:off /s /c "..."`), it is appended
/// verbatim after the quoted program path.
pub fn build_windows_command_line(
    program: &str,
    args: &[String],
    raw_tail: Option<&str>,
) -> String {
    let mut parts = Vec::with_capacity(1 + args.len());
    parts.push(quote_windows_arg(program));
    for arg in args {
        parts.push(quote_windows_arg(arg));
    }
    let mut joined = parts.join(" ");
    if let Some(raw) = raw_tail {
        if !raw.is_empty() {
            joined.push(' ');
            joined.push_str(raw);
        }
    }
    joined
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_windows_argv(line: &str) -> Vec<String> {
        let mut argv = Vec::new();
        let chars: Vec<char> = line.chars().collect();
        let mut current = String::new();
        let mut quoted = false;
        let mut started = false;
        let mut i = 0;
        while i < chars.len() {
            let ch = chars[i];
            if !started && (ch == ' ' || ch == '\t') {
                i += 1;
                continue;
            }
            started = true;
            if ch == '\\' {
                let mut bs = 0;
                while i < chars.len() && chars[i] == '\\' {
                    bs += 1;
                    i += 1;
                }
                if i < chars.len() && chars[i] == '"' {
                    for _ in 0..(bs / 2) {
                        current.push('\\');
                    }
                    if bs % 2 == 1 {
                        current.push('"');
                        i += 1;
                    }
                } else {
                    for _ in 0..bs {
                        current.push('\\');
                    }
                }
                continue;
            }
            if ch == '"' {
                if quoted && i + 1 < chars.len() && chars[i + 1] == '"' {
                    current.push('"');
                    i += 2;
                    continue;
                }
                quoted = !quoted;
                i += 1;
                continue;
            }
            if !quoted && (ch == ' ' || ch == '\t') {
                argv.push(std::mem::take(&mut current));
                started = false;
                i += 1;
                continue;
            }
            current.push(ch);
            i += 1;
        }
        if started {
            argv.push(current);
        }
        argv
    }

    #[test]
    fn quotes_special_arguments_losslessly() {
        assert_eq!(quote_windows_arg("plain"), "plain");
        assert_eq!(quote_windows_arg(""), "\"\"");
        assert_eq!(quote_windows_arg("a b"), "\"a b\"");
        assert_eq!(quote_windows_arg("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote_windows_arg("C:\\dir\\"), "C:\\dir\\");
        assert_eq!(quote_windows_arg("C:\\dir with space\\"), "\"C:\\dir with space\\\\\"");
        assert_eq!(quote_windows_arg("{\"enableTerminalSandbox\":false}"), "\"{\\\"enableTerminalSandbox\\\":false}\"");

        let samples = vec![
            "C:\\Program Files\\nodejs\\node.exe".to_string(),
            "".to_string(),
            "a&b|c^d".to_string(),
            "%PATH%".to_string(),
            "!delayed!".to_string(),
            "C:\\dir\\".to_string(),
            "C:\\dir with space\\".to_string(),
            "\"quoted\"".to_string(),
            "line1\nline2".to_string(),
            "中文 🚀".to_string(),
        ];
        let line = build_windows_command_line(&samples[0], &samples[1..], None);
        assert_eq!(parse_windows_argv(&line), samples);
    }

    #[test]
    fn builds_command_line_with_optional_raw_tail() {
        let cmd = build_windows_command_line(
            "C:\\Windows\\System32\\cmd.exe",
            &[],
            Some("/d /v:off /s /c \"\"D:\\bin\\tool.cmd\" \"a&b\"\""),
        );
        assert_eq!(
            cmd,
            "C:\\Windows\\System32\\cmd.exe /d /v:off /s /c \"\"D:\\bin\\tool.cmd\" \"a&b\"\""
        );
    }
}
