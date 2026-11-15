# Run with the GitHub Pages Jekyll version: gem install jekyll -v 3.10.0
require "jekyll"
require "json"
require "tmpdir"

docs = File.expand_path("../../docs", __dir__)
seed = JSON.parse(File.read(File.join(docs, "_data/apps.json")))
seed_version = seed.fetch("apps").first.fetch("versions").first
releases = %w[1.0.3 1.10.0 1.9.0 2.0.0 2.1.0].map do |version|
  {
    "tag_name" => "v#{version}",
    "prerelease" => version == "2.0.0",
    "published_at" => seed_version.fetch("date"),
    "assets" => [{
      "name" => "OneDrop-#{version}.ipa",
      "state" => version == "2.1.0" ? "starter" : "uploaded",
      "size" => seed_version.fetch("size"),
      "browser_download_url" => seed_version.fetch("downloadURL").gsub("1.0.3", version),
    }],
  }
end

beta_releases = %w[1.0.2 1.0.10 1.0.11 1.0.12].map do |version|
  asset = {
    "name" => "OneDrop-Beta-#{version}.ipa", "size" => 500,
    "state" => version == "1.0.12" ? "starter" : "uploaded",
    "browser_download_url" => "https://example.org/OneDrop-Beta-#{version}.ipa",
  }
  {
    "tag_name" => "ios-beta-v#{version}", "draft" => version == "1.0.11",
    "prerelease" => true, "published_at" => seed_version.fetch("date"), "assets" => [asset],
  }
end
Dir.mktmpdir do |output|
  config = Jekyll.configuration("source" => docs, "destination" => output, "github" => { "releases" => releases })
  site = Jekyll::Site.new(config)
  site.process
  raise "Unreleased beta listed" unless JSON.parse(File.read(File.join(output, "apps.json"))).fetch("apps").length == 1
  releases.concat(beta_releases)
  2.times do
    site.process
    stable, beta = JSON.parse(File.read(File.join(output, "apps.json"))).fetch("apps")
    raise "Incorrect beta identity" unless beta.fetch("bundleIdentifier") == "com.sycamore.onedrop.beta" && beta.fetch("beta")
    beta_versions = beta.fetch("versions")
    raise "Incorrect beta release order" unless beta_versions.map { |entry| entry.fetch("version") } == %w[1.0.10 1.0.2]
    beta_versions.each do |entry|
      version = entry.fetch("version")
      raise "Incorrect beta IPA metadata" unless entry.fetch("buildNumber") == version && entry.fetch("downloadURL") == "https://example.org/OneDrop-Beta-#{version}.ipa" && entry.fetch("size") == 500
    end
    versions = stable.fetch("versions")
    raise "Incorrect release order" unless versions.map { |entry| entry.fetch("version") } == %w[1.10.0 1.9.0 1.0.3]
    raise "Incorrect IPA metadata" unless versions.last == seed_version.merge("date" => Time.parse(seed_version.fetch("date")).localtime.xmlschema)
  end
end
