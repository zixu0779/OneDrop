# Run with the GitHub Pages Jekyll version: gem install jekyll -v 3.10.0
require "jekyll"
require "json"
require "tmpdir"
require "cgi"

Jekyll.logger.log_level = :error
DOCS = File.expand_path("../../docs", __dir__)
FIXTURES = JSON.parse(File.read(File.join(__dir__, "fixtures/website-releases.json")))

# This exercises the real homepage and includes, with the same metadata shape as GitHub Pages.
def render_site(releases, output)
  config = Jekyll.configuration("source" => DOCS, "destination" => output, "quiet" => true, "github" => { "releases" => releases })
  Jekyll::Site.new(config).process
  File.read(File.join(output, "index.html"))
end

def release(version, body = "", **extra)
  {
    "tag_name" => "v#{version}", "published_at" => "2026-11-24T10:00:00Z",
    "draft" => false, "prerelease" => false, "body" => body,
  }.merge(extra.transform_keys(&:to_s))
end

def versions(html)
  html.scan(/aria-label="Select release ([^"]+)"/).flatten
end

def summary(title = "A short update.", changes = ["- New: A useful feature."])
  "<!-- website-summary:start -->\n### #{title}\n#{changes.join("\n")}\n<!-- website-summary:end -->"
end

def check(condition, message)
  raise message unless condition
end

if ARGV.first == "--render-cases"
  Dir.mktmpdir do |output|
    cases = [0, 1, 3, 4, 8].to_h { |count| [count, render_site(FIXTURES.first(count), output)] }
    puts JSON.generate(cases)
  end
  exit
elsif ARGV.first == "--preview"
  input, output = ARGV[1], ARGV[2]
  abort "Usage: ruby #{__FILE__} --preview releases.json output-directory" unless input && output
  render_site(JSON.parse(File.read(input)), File.expand_path(output))
  puts File.join(File.expand_path(output), "index.html")
  exit
end

Dir.mktmpdir do |output|
  html = render_site(FIXTURES.reverse, output)
  check(versions(html) == FIXTURES.map { |item| item.fetch("tag_name") }, "Historical versions/order changed")
  historical = JSON.parse(File.read(File.join(DOCS, "_data/release_summaries.json")))
  historical.each_value do |entry|
    check(html.include?(CGI.escapeHTML(entry.fetch("title"))), "Historical title changed")
    entry.fetch("changes").each do |change|
      check(html.include?(CGI.escapeHTML(change.fetch("text"))), "Historical summary changed")
    end
  end
  [0, 1, 3, 4].each do |count|
    page = render_site(FIXTURES.first(count), output)
    check(versions(page).size == count, "Incorrect entry count #{count}")
    check(page.include?('id="show-releases"') == (count > 3), "Incorrect archive controls #{count}")
    check(page.scan(/<article\s+class="[^"]*release-last/).size == (count.zero? ? 0 : count > 3 ? 2 : 1), "Incorrect endpoints #{count}")
  end

  candidates = [release("1.9.0"), release("1.10.0"), release("2.0.0", "", prerelease: true), release("3.0.0", "", draft: true)]
  %w[1.2.3-beta 01.2.3 1.2 1.2.3. 1.2.3.4 1..2 1.2.<script>].each { |version| candidates << release(version) }
  candidates << release("9.0.0", "", published_at: nil)
  check(versions(render_site(candidates, output)) == %w[v1.10.0 v1.9.0], "Stable numeric filtering/sort failed")

  # Explicit summaries override history. Pipes, CRLF and HTML-like text must remain text.
  safe_body = summary("Better | <img src=x onerror=alert(1)>", ["- Fixed: <script>alert('x')</script> & a | b."]).gsub("\n", "\r\n")
  page = render_site([release("1.2.0", safe_body)], output)
  check(page.include?("Better | &lt;img"), "Title was not escaped")
  check(page.include?("&lt;script&gt;alert"), "Summary was not escaped")
  check(!page.include?(historical.fetch("1.2.0").fetch("title")), "Explicit summary did not override history")
  check(!page.include?("<img src=x") && !page.include?("<script>alert"), "Unsafe summary HTML")

  malformed = [
    "TECHNICAL_SECRET", summary + summary,
    summary.sub("<!-- website-summary:end -->", ""),
    summary.sub("<!-- website-summary:start -->", ""),
    "<!-- website-summary:end -->\n<!-- website-summary:start -->\n### Wrong order\n- New: Wrong.",
    summary("x" * 81), summary("Fine", ["- Fixed: #{'x' * 241}"]),
    summary("Fine", ["- New: One."] * 4), summary("Fine", []),
    summary("Fine", ["- Unknown: Text."]), summary("Fine", ["- New: "]),
  ]
  malformed.each do |body|
    page = render_site([release("4.0.0", body + "\nTECHNICAL_SECRET")], output)
    check(page.include?("<h3>Release update.</h3>"), "Malformed summary should use generic fallback")
    check(!page.include?("TECHNICAL_SECRET"), "Full body leaked into homepage")
    check(page.include?("https://github.com/zixu0779/OneDrop/releases/tag/v4.0.0"), "Missing fallback release link")
  end
  fallback = render_site([release("1.2.0", "No summary")], output)
  check(fallback.include?(historical.fetch("1.2.0").fetch("title")), "Historical fallback missing")
  first = render_site([release("4.0.0", summary("Before edit."))], output)
  edited = render_site([release("4.0.0", summary("After edit."))], output)
  check(first.include?("Before edit.") && edited.include?("After edit.") && !edited.include?("Before edit."), "Release edits did not update")
  check(versions(render_site([], output)).empty?, "Deleted release persisted")
end
puts "Website release notes: fixtures passed"
