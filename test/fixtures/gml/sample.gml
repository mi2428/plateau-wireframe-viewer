<?xml version="1.0" encoding="UTF-8"?>
<!-- Synthetic building only. Every coordinate and identifier is invented. -->
<core:CityModel xmlns:core="http://www.opengis.net/citygml/2.0"
                xmlns:gml="http://www.opengis.net/gml"
                xmlns:bldg="http://www.opengis.net/citygml/building/2.0">
  <gml:boundedBy>
    <gml:Envelope srsName="http://www.opengis.net/def/crs/EPSG/0/6697" srsDimension="3">
      <gml:lowerCorner>35.0000 135.0000 12</gml:lowerCorner>
      <gml:upperCorner>35.0002 135.0003 27</gml:upperCorner>
    </gml:Envelope>
  </gml:boundedBy>
  <core:cityObjectMember>
    <bldg:Building gml:id="synthetic-building">
      <bldg:lod2MultiSurface>
        <gml:MultiSurface>
          <gml:surfaceMember>
            <gml:Polygon gml:id="roof-with-hole">
              <gml:exterior><gml:LinearRing><gml:posList count="5">35.0000 135.0000 27 35.0000 135.0003 27 35.0002 135.0003 27 35.0002 135.0000 27 35.0000 135.0000 27</gml:posList></gml:LinearRing></gml:exterior>
              <gml:interior><gml:LinearRing><gml:posList>35.00007 135.00010 27 35.00013 135.00010 27 35.00013 135.00020 27 35.00007 135.00020 27 35.00007 135.00010 27</gml:posList></gml:LinearRing></gml:interior>
            </gml:Polygon>
          </gml:surfaceMember>
          <gml:surfaceMember>
            <gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>35.0000 135.0000 12 35.0002 135.0000 12 35.0002 135.0003 12 35.0000 135.0003 12 35.0000 135.0000 12</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>
          </gml:surfaceMember>
          <gml:surfaceMember>
            <gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>35.0000 135.0000 12 35.0000 135.0003 12 35.0000 135.0003 27 35.0000 135.0000 27 35.0000 135.0000 12</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>
          </gml:surfaceMember>
          <gml:surfaceMember>
            <gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>35.0000 135.0003 12 35.0002 135.0003 12 35.0002 135.0003 27 35.0000 135.0003 27 35.0000 135.0003 12</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>
          </gml:surfaceMember>
          <gml:surfaceMember>
            <gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>35.0002 135.0003 12 35.0002 135.0000 12 35.0002 135.0000 27 35.0002 135.0003 27 35.0002 135.0003 12</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>
          </gml:surfaceMember>
          <gml:surfaceMember>
            <gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>35.0002 135.0000 12 35.0000 135.0000 12 35.0000 135.0000 27 35.0002 135.0000 27 35.0002 135.0000 12</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>
          </gml:surfaceMember>
        </gml:MultiSurface>
      </bldg:lod2MultiSurface>
    </bldg:Building>
  </core:cityObjectMember>
</core:CityModel>
