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

Dir.mktmpdir do |output|
  config = Jekyll.configuration("source" => docs, "destination" => output, "github" => { "releases" => releases })
  site = Jekyll::Site.new(config)
  2.times do
    site.process
    versions = JSON.parse(File.read(File.join(output, "apps.json"))).fetch("apps").first.fetch("versions")
    raise "Incorrect release order" unless versions.map { |entry| entry.fetch("version") } == %w[1.10.0 1.9.0 1.0.3]
    raise "Incorrect IPA metadata" unless versions.last == seed_version.merge("date" => Time.parse(seed_version.fetch("date")).localtime.xmlschema)
  end
end
