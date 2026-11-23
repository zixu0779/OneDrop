require "jekyll"
require "json"
require "tmpdir"
docs = File.expand_path("../../docs", __dir__)
releases = %w[1.9.0 1.10.0].map do |version|
  {"tag_name" => "v#{version}", "draft" => false, "prerelease" => false, "assets" => %w[android.apk mobile-edge.crx].map { |suffix| {"name" => "OneDrop-#{version}-#{suffix}", "state" => "uploaded", "size" => 10, "digest" => "sha256:" + "a" * 64, "browser_download_url" => "https://github.com/zixu0779/OneDrop/releases/download/v#{version}/OneDrop-#{version}-#{suffix}"} }}
end
releases << {"tag_name" => "ios-beta-v2.0.0", "prerelease" => true, "assets" => [{"name" => "OneDrop-Beta-2.0.0.ipa", "state" => "uploaded", "size" => 10, "digest" => "sha256:" + "b" * 64, "browser_download_url" => "https://github.com/zixu0779/OneDrop/releases/download/ios-beta-v2.0.0/OneDrop-Beta-2.0.0.ipa"}]}
releases << releases.first.merge("draft" => true)
releases << releases.first.merge("tag_name" => "v3.0.0", "prerelease" => true)
if ARGV.first
  releases = JSON.parse(File.read(ARGV.first))
end
Dir.mktmpdir do |output|
  site = Jekyll::Site.new(Jekyll.configuration("source" => docs, "destination" => output, "github" => {"releases" => releases}))
  site.process
  feed = JSON.parse(File.read(File.join(output,"updates.json")))
  raise "Bad schema" unless feed["schemaVersion"] == 1
  assets = feed.fetch("assets")
  raise "Empty feed" if assets.empty?
  assets.each do |asset|
    raise "No hash" unless asset.fetch("sha256").match?(/\A[a-f0-9]{64}\z/)
    raise "Bad platform" unless %w[android ios mobile-edge].include?(asset.fetch("platform"))
    raise "Beta leaked" if asset.fetch("channel") == "beta" && asset.fetch("platform") != "ios"
  end
  unless ARGV.first
    raise "Draft/prerelease included or asset missing" unless assets.length == 5
    raise "Channels mixed" unless assets.count { |asset| asset["channel"] == "beta" } == 1
  end
  puts "Validated #{assets.length} update assets"
end
